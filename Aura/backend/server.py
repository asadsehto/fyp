import subprocess
import time
import os
import threading
import json
import uuid
import urllib.request
import sqlite3
import datetime
import sys
from typing import List, Optional
from fastapi import FastAPI, File, UploadFile, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

try:
    import sounddevice as sd
    import numpy as np
    from scipy.io.wavfile import write as write_wav
    AUDIO_SUPPORTED = True
except ImportError:
    AUDIO_SUPPORTED = False

# anthropic/openai are imported lazily inside summarise_with_claude/openai
# instead of here — importing them at module load time was observed to add
# ~20s to backend cold-start (httpx/pydantic/etc import chain), which the
# Electron app pays on every single launch regardless of which AI provider
# is actually selected. Deferring the import means only users who pick
# Claude/OpenAI pay that cost, and only on first use.

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Persistent Data Directory ───────────────────────────────────
# Use a stable directory under user home so data survives app restarts
# and doesn't depend on the CWD of the packaged Electron app.
DATA_DIR = os.path.join(os.path.expanduser("~"), ".aura")
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, "aura.db")
WAV_PATH = os.path.join(DATA_DIR, "recording.wav")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")

print(f"[Aura] Data directory: {DATA_DIR}")
print(f"[Aura] Database path: {DB_PATH}")

# ── Local Database (SQLite) ─────────────────────────────────────
def get_db():
    """Get a new database connection. Always creates table if missing."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''CREATE TABLE IF NOT EXISTS lectures
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  timestamp TEXT,
                  transcript TEXT,
                  summary TEXT)''')
    conn.commit()
    return conn

# Initialize on startup
get_db().close()

# ── Persisted App Config ─────────────────────────────────────────
# Everything the setup wizard collects lives here so it survives app
# restarts, instead of only living in React state.
DEFAULT_CONFIG = {
    "aiProvider": "Ollama",
    "openaiKey": "",
    "claudeKey": "",
    "elearningEmail": "",
    "elearningPassword": "",
    "lmsEmail": "",
    "lmsPassword": "",
    "channels": {
        "telegram": {"enabled": False, "target": ""},
        "whatsapp": {"enabled": False, "target": ""},
    },
    "hasCompletedSetup": False,
}

def load_config() -> dict:
    merged = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            merged.update(loaded)
            merged["channels"] = {**DEFAULT_CONFIG["channels"], **loaded.get("channels", {})}
        except Exception as e:
            print(f"[Aura] Failed to load config, using defaults: {e}")
    return merged

def save_config():
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(app_config, f, indent=2)
    except Exception as e:
        print(f"[Aura] Failed to save config: {e}")

app_config = load_config()

# Global variables for recording state
recording_chunks: list = []  # list of numpy arrays
is_recording = False
samplerate = 16000
audio_thread = None

# Lazy initialize Whisper model
whisper_model = None

class MockWhisperModel:
    def transcribe(self, wav_path, **kwargs):
        class Segment:
            def __init__(self, text):
                self.text = text
        class Info:
            pass
        return [Segment("This is a placeholder transcript. (Local AI model download was blocked by HuggingFace or your network, so we are using this mock text to let you test OpenClaw delivery.)")], Info()

def get_whisper_model():
    global whisper_model
    if whisper_model is None:
        print("[Aura] Loading Whisper model (small)...")
        try:
            whisper_model = WhisperModel("small", device="cpu", compute_type="int8")
            print("[Aura] Whisper model loaded successfully.")
        except Exception as e:
            print(f"[Aura] Failed to load Whisper model: {e}")
            print("[Aura] Using mock model for testing...")
            whisper_model = MockWhisperModel()
    return whisper_model

def record_audio():
    """Record audio from the default input device into recording_chunks."""
    global recording_chunks, is_recording
    recording_chunks = []

    def callback(indata, frames, time_info, status):
        if status:
            print(f"[Aura] Audio status: {status}")
        if is_recording:
            # indata is a numpy array of shape (frames, channels)
            # .copy() is critical — the buffer is reused by sounddevice
            recording_chunks.append(indata.copy())

    try:
        with sd.InputStream(samplerate=samplerate, channels=1, dtype='float32', callback=callback):
            print("[Aura] Recording started...")
            while is_recording:
                sd.sleep(100)
        print(f"[Aura] Recording stopped. Captured {len(recording_chunks)} chunks.")
    except Exception as e:
        print(f"[Aura] Recording error: {e}")

@app.get("/health/dependencies")
def check_dependencies(check: str = "openclaw"):
    try:
        if check == "openclaw":
            subprocess.run("openclaw --version", check=True, capture_output=True, shell=True)
        elif check == "ollama":
            subprocess.run("ollama --version", check=True, capture_output=True, shell=True)
        return {"status": "ok"}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {"status": "error", "message": f"{check} not found"}

@app.post("/install/ollama")
def install_ollama():
    try:
        subprocess.Popen("winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements", shell=True)
        return {"status": "installing"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ── Config Persistence ────────────────────────────────────────────

@app.get("/config")
def get_config():
    return app_config

@app.post("/config")
async def update_config(request: Request):
    """Merge posted fields into the persisted config. 'channels' is deep-merged
    per-channel so setting one channel doesn't clobber the other."""
    body = await request.json()
    for key, value in body.items():
        if key == "channels" and isinstance(value, dict):
            app_config.setdefault("channels", {})
            for ch, ch_cfg in value.items():
                app_config["channels"].setdefault(ch, {})
                app_config["channels"][ch].update(ch_cfg)
        else:
            app_config[key] = value
    save_config()
    return app_config

def read_openclaw_json() -> dict:
    try:
        openclaw_json_path = os.path.join(os.path.expanduser("~"), ".openclaw", "openclaw.json")
        if os.path.exists(openclaw_json_path):
            with open(openclaw_json_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[Aura] read_openclaw_json error: {e}")
    return {}

def get_openclaw_channels() -> dict:
    """Real channel provisioning state from OpenClaw's own config (not just our
    app's config intent) — e.g. WhatsApp can have leftover credentials on disk
    from a past pairing while not actually being provisioned right now.

    Deliberately reads openclaw.json directly instead of shelling out to
    `openclaw channels list --json`: that command was observed to probe live
    channel connectivity and take 30s+ (or longer) when a channel's API is
    unreachable (e.g. Telegram blocked on this network) — far too slow to sit
    behind a status endpoint the UI polls."""
    return read_openclaw_json().get("channels", {})

@app.get("/status")
def get_status():
    """Aggregated, provable system status for the Settings screen."""
    def check(cmd):
        try:
            subprocess.run(cmd, check=True, capture_output=True, shell=True, timeout=8)
            return True
        except Exception:
            return False

    oc_channels = get_openclaw_channels()

    channels_status = {}
    for ch, cfg in app_config.get("channels", {}).items():
        paired = bool(oc_channels.get(ch, {}).get("enabled"))
        channels_status[ch] = {
            "enabled": cfg.get("enabled", False),
            "target": cfg.get("target", ""),
            "configured": bool(cfg.get("enabled") and cfg.get("target")),
            "paired": paired,
        }

    return {
        "openclaw": check("openclaw --version"),
        "ollama": check("ollama --version"),
        "aiProvider": app_config.get("aiProvider", "Ollama"),
        "channels": channels_status,
    }

@app.post("/record/start")
def start_recording():
    global is_recording, audio_thread
    if not AUDIO_SUPPORTED:
        return {"status": "mock_recording_started"}

    is_recording = True
    audio_thread = threading.Thread(target=record_audio, daemon=True)
    audio_thread.start()
    return {"status": "recording"}

SKILL_PROMPT = """You are a lecture summariser. Output ONLY in this exact format, no extra text:

SUMMARY:
- (max 10 bullets, academic content only, ignore greetings)

ASSIGNMENTS DETECTED: none
(or list tasks if mentioned: Task / Deadline / Submit via)

UPLOAD NEEDED: YES / NO
UPLOAD REASON: (what to upload and where)

Rules: English only, never invent info not in transcript.
CRITICAL RULE: If the transcript mentions the lecturer uploading examples, assignments, presentations, or referencing online courses, decide whether it is something that should end up on eLearning. If yes, set UPLOAD NEEDED: YES, and in UPLOAD REASON, describe clearly what needs to be uploaded and where. NOTE: automatic eLearning submission is not wired up yet, so do NOT claim the agent will search online, build a document, or submit it automatically — just flag it plainly so the teacher can handle it, or ask the assistant for manual help.

TRANSCRIPT:
{transcript}"""

# ── Multi-Provider AI Dispatch ────────────────────────────────────
# One generic "ask this provider a prompt" layer, reused by both the
# lecture summarizer (SKILL_PROMPT-shaped) and the library RAG search
# (free-form question shaped) — same provider/key handling, no duplication.

def ask_ollama(prompt: str) -> str:
    body = json.dumps({"model": "minimax-m3:cloud", "prompt": prompt, "stream": False})
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=body.encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
            return data.get("response", "").strip()
    except Exception as e:
        return f"Ollama connection error: Ensure Ollama is running and has a model installed. ({e})"

def ask_claude(prompt: str, api_key: str) -> str:
    if not api_key:
        return "Error: No Claude API key configured. Add one in Settings."
    try:
        import anthropic
    except ImportError:
        return "Error: the 'anthropic' package is not installed on the backend."
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model="claude-sonnet-5",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in resp.content if hasattr(block, "text")).strip()
    except Exception as e:
        return f"Claude API error: {e}"

def ask_openai(prompt: str, api_key: str) -> str:
    if not api_key:
        return "Error: No OpenAI API key configured. Add one in Settings."
    try:
        import openai
    except ImportError:
        return "Error: the 'openai' package is not installed on the backend."
    try:
        client = openai.OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1500,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        return f"OpenAI API error: {e}"

def ask_ai(prompt: str, config: dict) -> str:
    provider = config.get("aiProvider", "Ollama")
    if provider == "Claude":
        return ask_claude(prompt, config.get("claudeKey", ""))
    if provider == "OpenAI":
        return ask_openai(prompt, config.get("openaiKey", ""))
    return ask_ollama(prompt)

def summarise(transcript_text: str, config: dict) -> str:
    limit = 6000 if config.get("aiProvider", "Ollama") == "Ollama" else 12000
    prompt = SKILL_PROMPT.format(transcript=transcript_text[:limit])
    return ask_ai(prompt, config)

# ── OpenClaw Session Routing ──────────────────────────────────────
# One consistent session per channel/peer so a pushed summary, a reply typed
# in Telegram/WhatsApp, and a prompt typed into the app's "Ask Agent" box are
# all the SAME conversation (verified against `openclaw sessions list` output:
# real sessions are keyed exactly as "agent:main:<channel>:<peerId>").

def session_key_for(channel: str, target: str) -> str:
    return f"agent:main:{channel}:{target}"

def enabled_channels() -> dict:
    return {c: cfg for c, cfg in app_config.get("channels", {}).items()
            if cfg.get("enabled") and cfg.get("target")}

def autodetect_target(channel: str) -> Optional[str]:
    """Scan openclaw.json's commands.ownerAllowFrom for a '<channel>:<id>' entry."""
    try:
        openclaw_json_path = os.path.join(os.path.expanduser("~"), ".openclaw", "openclaw.json")
        if os.path.exists(openclaw_json_path):
            with open(openclaw_json_path, "r", encoding="utf-8") as f:
                oc_config = json.load(f)
            owner_allow_from = oc_config.get("commands", {}).get("ownerAllowFrom", [])
            for entry in owner_allow_from:
                if entry.startswith(f"{channel}:"):
                    return entry.split(":", 1)[1]
    except Exception as e:
        print(f"[Aura] autodetect_target error for {channel}: {e}")
    return None

def dispatch_to_channels(message_text: str) -> dict:
    """Push a message into every enabled channel's persistent agent session
    (via `openclaw agent --deliver`, not a bare `message send`) so the agent
    turn actually happens and the teacher can immediately reply and continue
    the same conversation."""
    results = {}
    for channel, cfg in enabled_channels().items():
        target = cfg["target"]
        try:
            temp_file = os.path.join(DATA_DIR, f"temp_dispatch_{channel}_{uuid.uuid4().hex[:8]}.txt")
            with open(temp_file, "w", encoding="utf-8") as f:
                f.write(message_text)
            skey = session_key_for(channel, target)
            cmd = (
                f'openclaw agent --channel {channel} --to {target} '
                f'--session-key {skey} --message-file "{temp_file}" --deliver --timeout 180'
            )
            print(f"[Aura] Dispatching to {channel} ({target}) session={skey}")
            subprocess.Popen(cmd, shell=True, encoding="utf-8")
            results[channel] = "dispatched"
        except Exception as e:
            print(f"[Aura] Dispatch error on {channel}: {e}")
            results[channel] = f"error: {e}"
    return results

@app.post("/record/stop")
def stop_recording():
    global is_recording, audio_thread, recording_chunks

    if AUDIO_SUPPORTED:
        is_recording = False
        if audio_thread:
            audio_thread.join(timeout=5)

        if len(recording_chunks) > 0:
            # Concatenate all chunks into one contiguous numpy array
            audio_array = np.concatenate(recording_chunks, axis=0)
            # Convert float32 [-1, 1] to int16 for WAV
            audio_int16 = np.int16(audio_array * 32767)
            write_wav(WAV_PATH, samplerate, audio_int16)
            duration_sec = len(audio_int16) / samplerate
            print(f"[Aura] Saved {WAV_PATH} — {duration_sec:.1f}s, {len(audio_int16)} samples")
        else:
            print("[Aura] WARNING: No audio chunks captured!")
            with open(WAV_PATH, "wb") as f:
                f.write(b"")
    else:
        print("[Aura] Audio not supported, writing empty WAV")
        with open(WAV_PATH, "wb") as f:
            f.write(b"")

    try:
        model = get_whisper_model()
        print("[Aura] Transcribing with faster-whisper...")
        segments, info = model.transcribe(
            WAV_PATH,
            task="translate",
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=400,
            ),
        )
        transcript = " ".join(seg.text.strip() for seg in segments).strip()

        if not transcript:
            transcript = "No audible speech was detected in the recording."

        print(f"[Aura] Transcript ({len(transcript)} chars): {transcript[:200]}...")

        print(f"[Aura] Summarizing with {app_config.get('aiProvider', 'Ollama')}...")
        summary = summarise(transcript, app_config)

        # Save to local database
        conn = get_db()
        c = conn.cursor()
        timestamp = datetime.datetime.now().isoformat()
        c.execute("INSERT INTO lectures (timestamp, transcript, summary) VALUES (?, ?, ?)",
                  (timestamp, transcript, summary))
        conn.commit()
        conn.close()
        print(f"[Aura] Lecture saved to DB at {timestamp}")

        # INSTANT DISPATCH TO EVERY ENABLED CHANNEL (Telegram / WhatsApp)
        agent_prompt = (
            f"I just recorded a new lecture. Here is the summary generated by the system:\n\n{summary}\n\n"
            "Please share this summary with me. If UPLOAD NEEDED is YES, tell me what needs to be uploaded "
            "and where — automatic eLearning submission isn't wired up yet, so offer to help me prepare it "
            "manually or remind me later instead of claiming you'll upload it yourself."
        )
        dispatch_to_channels(agent_prompt)

        return {"summary": summary}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"summary": f"Error during processing: {str(e)}"}

# ── OpenClaw Setup & Channel Management ──────────────────────────

@app.post("/openclaw/setup")
def openclaw_setup():
    """Launch the interactive OpenClaw channel configuration terminal."""
    try:
        subprocess.Popen('cmd.exe /c start cmd.exe /k "openclaw channels add"', shell=True)
        return {"status": "launched"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/channels/{channel}/configure")
def configure_channel(channel: str, enabled: bool = Form(True), manual_target: str = Form("")):
    """Enable/link a single channel (telegram or whatsapp) independently of the other."""
    channel = channel.lower()
    if channel not in ("telegram", "whatsapp"):
        return JSONResponse(status_code=400, content={"status": "error", "message": f"Unsupported channel: {channel}"})

    manual_target = manual_target.strip()
    detected = autodetect_target(channel)
    existing = app_config["channels"].get(channel, {}).get("target", "")
    target = manual_target or detected or existing

    app_config["channels"][channel] = {"enabled": enabled, "target": target}
    save_config()

    print(f"[Aura] Configured {channel}: enabled={enabled} target={target}")
    return {
        "status": "ok",
        "channel": channel,
        "enabled": enabled,
        "target": target,
        "auto_detected": bool(detected and not manual_target),
    }

# ── Dispatch (Send Summary to Telegram/WhatsApp) ────────────────

@app.post("/dispatch")
async def dispatch_message(summary: str = Form(...), files: List[UploadFile] = File(default=[])):
    try:
        targets = enabled_channels()
        if not targets:
            return JSONResponse(status_code=400, content={
                "status": "error",
                "message": "No channel configured. Go to Settings and enable + link Telegram or WhatsApp."
            })

        file_paths = []
        for file in files:
            file_path = os.path.join(DATA_DIR, f"temp_{uuid.uuid4().hex[:8]}_{file.filename}")
            with open(file_path, "wb") as f:
                f.write(await file.read())
            file_paths.append(file_path)

        message = f"Lecture Summary\n\n{summary}".replace('"', '\\"')

        sent, errors = [], []
        for channel, cfg in targets.items():
            target = cfg["target"]
            if file_paths:
                # `message send` only accepts a single --media per call, so send
                # the text once, then attach each file as its own message.
                cmd = f'openclaw message send --channel {channel} --target {target} --message "{message}"'
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8", timeout=60)
                ok = result.returncode == 0
                for path in file_paths:
                    media_cmd = f'openclaw message send --channel {channel} --target {target} --media "{path}"'
                    media_result = subprocess.run(media_cmd, shell=True, capture_output=True, text=True, encoding="utf-8", timeout=60)
                    ok = ok and media_result.returncode == 0
                    if media_result.returncode != 0:
                        errors.append(f"{channel} (media): {(media_result.stderr or media_result.stdout).strip()[:200]}")
            else:
                cmd = f'openclaw message send --channel {channel} --target {target} --message "{message}"'
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8", timeout=60)
                ok = result.returncode == 0

            if ok:
                sent.append(channel)
            else:
                errors.append(f"{channel}: {(result.stderr or result.stdout).strip()[:200]}")

        for path in file_paths:
            try:
                os.remove(path)
            except Exception:
                pass

        if not sent:
            return JSONResponse(status_code=500, content={"status": "error", "message": "OpenClaw error: " + "; ".join(errors)})
        message_summary = f"Sent to: {', '.join(sent)}"
        if errors:
            message_summary += f" (failed: {'; '.join(errors)})"
        return {"status": "success", "message": message_summary}
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=500, content={"status": "error", "message": "OpenClaw timed out. Make sure 'openclaw gateway run' is active."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

# ── Agent Execution ──────────────────────────────────────────────

@app.post("/agent/execute")
async def execute_agent(
    prompt: str = Form(...),
    summary: str = Form(""),
    channel: str = Form(""),
    files: List[UploadFile] = File(default=[]),
):
    try:
        targets = enabled_channels()
        if not targets:
            return JSONResponse(status_code=400, content={
                "status": "error",
                "message": "No delivery channel configured. Go to Settings and enable + link Telegram or WhatsApp."
            })

        chosen = channel if channel in targets else next(iter(targets))
        target = targets[chosen]["target"]
        skey = session_key_for(chosen, target)

        # Files the user attached in the app get saved locally, and the agent
        # is told their real path — OpenClaw's own filesystem tool can then
        # open/read/upload them, same as if the user pointed it at a file
        # from the chat directly.
        saved_paths = []
        for f in files:
            dest = os.path.join(DATA_DIR, f"attach_{uuid.uuid4().hex[:8]}_{f.filename}")
            with open(dest, "wb") as out:
                out.write(await f.read())
            saved_paths.append(dest)

        message_parts = [prompt]
        if summary:
            message_parts.append(f"---\nReference lecture summary:\n{summary}")
        if saved_paths:
            file_list = "\n".join(f"- {p}" for p in saved_paths)
            message_parts.append(f"---\nAttached file(s) saved locally, use these exact paths:\n{file_list}")

        temp_prompt_file = os.path.join(DATA_DIR, f"temp_agent_prompt_{uuid.uuid4().hex[:8]}.txt")
        with open(temp_prompt_file, "w", encoding="utf-8") as f:
            f.write("\n\n".join(message_parts))

        cmd = (
            f'openclaw agent --message-file "{temp_prompt_file}" --session-key {skey} '
            f'--channel {chosen} --to {target} --deliver --timeout 180'
        )
        print(f"[Aura] Agent Execution ({chosen}, session={skey}): {cmd}")

        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8", timeout=200)

        try:
            os.remove(temp_prompt_file)
        except Exception:
            pass

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            return JSONResponse(status_code=500, content={"status": "error", "message": f"Agent failed: {err[:500]}"})

        return {"status": "success", "message": result.stdout.strip(), "channel": chosen}
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=500, content={"status": "error", "message": "Agent timed out after 200s."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/lectures")
def get_lectures():
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id, timestamp, transcript, summary FROM lectures ORDER BY id DESC")
        rows = c.fetchall()
        conn.close()

        lectures = []
        for row in rows:
            lectures.append({
                "id": row[0],
                "timestamp": row[1],
                "transcript": row[2],
                "summary": row[3]
            })
        return {"status": "ok", "lectures": lectures}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

# ── Library Search (ask questions across past lectures) ───────────
# Deliberately not a vector-DB/embeddings setup: OpenClaw's own memory
# search was checked and isn't usable here (no embedding provider actually
# configured, and it doesn't index this DB anyway). A semester's worth of
# lecture summaries is small enough to just hand the whole set to the model
# as context and let it answer with citations — simpler, no missing-API-key
# failure mode, fully within our control.
LIBRARY_ASK_PROMPT = """You answer questions about a teacher's past lectures using ONLY the summaries below.
Always say which lecture(s) you're citing by date. If nothing here answers the question, say so plainly — never invent an answer.

LECTURE SUMMARIES (most recent first):
{lectures}

QUESTION: {question}

Answer concisely and cite the date(s) your answer comes from."""

@app.post("/library/ask")
async def library_ask(question: str = Form(...)):
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id, timestamp, summary FROM lectures ORDER BY id DESC LIMIT 60")
        rows = c.fetchall()
        conn.close()

        if not rows:
            return {"status": "ok", "answer": "There are no recorded lectures yet to search."}

        lecture_block = "\n\n".join(f"[{r[1]}] (Lecture #{r[0]})\n{r[2]}" for r in rows)
        prompt = LIBRARY_ASK_PROMPT.format(lectures=lecture_block[:20000], question=question)
        answer = ask_ai(prompt, app_config)
        return {"status": "ok", "answer": answer}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
