"""
=============================================================
  LECTURE TRANSCRIBER — Laptop Version
  Uses: faster-whisper (large-v3-turbo)

  What it does:
    1. Records mic in 30-second chunks at 48000 Hz (WASAPI)
    2. Resamples each chunk to 16000 Hz for Whisper
    3. Transcribes + translates Urdu→English in one step
    4. Saves everything to transcripts/ folders
    5. P = pause/resume   S = stop and save

  NO argostranslate needed — Whisper handles translation itself
=============================================================
"""

import sounddevice as sd        # records from microphone
import numpy as np              # handles raw audio as numbers
import scipy.io.wavfile as wav  # writes temp WAV files
import scipy.signal as ssg      # resamples audio rate
import tempfile                 # temp files that auto-delete
import os
import time
import threading
import sys
import subprocess
from datetime import datetime
from pathlib import Path
from faster_whisper import WhisperModel

# Prevent Windows console encoding crashes
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')



# ─────────────────────────────────────────────────────────
#  CONFIGURATION
# ─────────────────────────────────────────────────────────

MIC_DEVICE     = None     # None = system default mic
                          # To find your device index run:
                          # py -3.11 -c "import sounddevice as sd; print(sd.query_devices())"

RECORD_RATE    = 16000    # Sample rate (must match your mic — run above command to verify)
WHISPER_RATE   = 16000    # Whisper requires exactly 16000 Hz
CHUNK_SECONDS  = 30       # seconds of audio per transcription chunk
CHANNELS       = 1        # mono
OVERLAP_SECS   = 2        # seconds of overlap between chunks to avoid cut words

# Model options (trade-off: speed vs accuracy):
#   tiny   → ~40 MB,  fastest  (~2s per chunk), lower accuracy
#   base   → ~80 MB,  fast     (~4s per chunk)
#   small  → ~250 MB, balanced (~8s per chunk)  ← currently selected
#   medium → ~800 MB, slow     (~20s per chunk)
MODEL_SIZE     = "small"
COMPUTE_TYPE   = "int8"   # int8 = less RAM, runs well on CPU

# Model cache — HuggingFace default: ~/.cache/huggingface/hub/
# faster-whisper uses this automatically. Model downloads once, loads fast every run after.
OUTPUT_DIR = Path("transcripts")


# ─────────────────────────────────────────────────────────
#  STEP 1 — Load Whisper model
#  Runs once at startup. Stays in RAM the whole session.
#  First run: downloads ~250 MB to HuggingFace cache (one time only)
#  Every run after: loads from local cache in ~5 seconds
# ─────────────────────────────────────────────────────────

def load_whisper_model():
    print(f"  Loading model '{MODEL_SIZE}'...")
    print(f"  (First time: downloads ~250 MB — subsequent runs load instantly from cache)")
    t0 = time.time()
    model = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type=COMPUTE_TYPE,
        # No download_root — uses default HuggingFace cache (~/.cache/huggingface)
    )
    print(f"  Model ready in {time.time()-t0:.1f}s\n")
    return model

# ─────────────────────────────────────────────────────────
#  STEP 1b — Summarise + deliver via OpenClaw
# ─────────────────────────────────────────────────────────

TELEGRAM_CHAT_ID = "7237088336"
OLLAMA_MODEL     = "minimax-m3:cloud"

SKILL_PROMPT = """You are a lecture summariser. Output ONLY in this exact format, no extra text:

SUMMARY:
- (max 10 bullets, academic content only, ignore greetings)

ASSIGNMENTS DETECTED: none
(or list tasks if mentioned: Task / Deadline / Submit via)

UPLOAD NEEDED: YES / NO
UPLOAD REASON: (what to upload and where)

Rules: English only, never invent info not in transcript.

TRANSCRIPT:
{transcript}"""


def summarise_with_ollama(transcript_text: str) -> str:
    """Call Ollama with the lecture-summariser skill prompt."""
    import json as _json
    import urllib.request as _req
    prompt = SKILL_PROMPT.format(transcript=transcript_text[:6000])
    body = _json.dumps({"model": OLLAMA_MODEL, "prompt": prompt, "stream": False})
    req = _req.Request(
        "http://127.0.0.1:11434/api/generate",
        data=body.encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with _req.urlopen(req, timeout=120) as resp:
            data = _json.loads(resp.read().decode())
            return data.get("response", "").strip()
    except Exception as e:
        return f"[Ollama error: {e}]"


def send_to_openclaw(transcript_path: Path):
    """
    1. Read the transcript
    2. Summarise via Ollama using the exact lecture-summariser skill format
    3. Deliver via OpenClaw (channel-agnostic — Telegram today, anything tomorrow)
    """
    print(f"\n  Reading transcript...")
    try:
        transcript_text = transcript_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"  Failed to read transcript: {e}")
        return

    print(f"  Summarising with Ollama ({OLLAMA_MODEL})...")
    summary = summarise_with_ollama(transcript_text)
    print(f"\n  Summary:\n{summary}\n")

    # ── Deliver via OpenClaw ────────────────────────────────────────────────────
    # OpenClaw owns the channel — switch Telegram → WhatsApp → app → anything
    # without changing this code. OpenClaw will also handle assignment approvals.
    print(f"  Sending via OpenClaw...")
    message = f"\U0001f4da Lecture Summary\n{transcript_path.name}\n\n{summary}"

    # shell=True lets Windows find openclaw through npm PATH without full path
    # timeout=120 because openclaw needs ~15s to start its embedded agent
    cmd = f'openclaw message send --channel telegram --target {TELEGRAM_CHAT_ID} --message "{message}"'
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
        if result.returncode == 0:
            print(f"  Done — delivered via OpenClaw!")
        else:
            err = (result.stderr or result.stdout).strip()
            print(f"  OpenClaw error: {err[:300]}")
    except subprocess.TimeoutExpired:
        print(f"  OpenClaw timed out — run: openclaw gateway run")


# ─────────────────────────────────────────────────────────
#  STEP 2 — Resample audio
#  Mic records at 48000 Hz, Whisper needs 16000 Hz
#  scipy.signal.resample_poly does this cleanly
#  up=1, down=3 means: keep 1 of every 3 samples
#  48000 / 3 = 16000 — exact, no quality loss
# ─────────────────────────────────────────────────────────

def resample_to_whisper(audio_48k: np.ndarray) -> np.ndarray:
    """
    Takes int16 audio at 48000 Hz.
    Returns int16 audio at 16000 Hz.
    Whisper will refuse audio that isn't exactly 16000 Hz.
    """
    # resample_poly needs float input
    audio_float = audio_48k.astype(np.float32)
    resampled = ssg.resample_poly(audio_float, up=1, down=3)
    # clip to int16 range to avoid overflow then convert back
    resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
    return resampled


# ─────────────────────────────────────────────────────────
#  STEP 3 — Transcribe one chunk
#  task="translate" tells Whisper to output English
#  regardless of whether teacher spoke Urdu or English
#  This replaces argostranslate entirely — Whisper does both
# ─────────────────────────────────────────────────────────

def transcribe_chunk(model: WhisperModel, audio_16k: np.ndarray) -> dict:
    """
    Takes a numpy int16 array at 16000 Hz.
    Returns { "text": "English text here", "language": "ur" }

    task="translate" → Whisper transcribes AND translates in one pass
    vad_filter=True  → skips silent parts automatically
    beam_size=5      → considers 5 candidates, picks the best
    """
    # Write chunk to a temp WAV file — faster-whisper reads from file path
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
        wav.write(tmp_path, WHISPER_RATE, audio_16k)

    try:
        segments, info = model.transcribe(
            tmp_path,
            task="translate",    # output English regardless of input language
            beam_size=5,
            vad_filter=False     # Disable silence-canceling filter
        )
        # segments is a generator — consume it all into one string
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return {"text": text, "language": info.language}

    finally:
        os.unlink(tmp_path)   # always delete temp file even if crash


# ─────────────────────────────────────────────────────────
#  STEP 4 — Append chunk to transcript file
#  File grows as class progresses
#  If laptop crashes mid-class, everything up to that point is saved
# ─────────────────────────────────────────────────────────

def save_chunk(filepath: Path, chunk_num: int, result: dict, timestamp: str):
    """
    Appends one transcribed chunk to the .txt transcript file.
    Format:
      [09:32:15] [Chunk 3] [UR → EN]
      Text here
      ------------------------------------------------------------
    """
    lang = result["language"].upper()
    text = result["text"]

    line = f"\n[{timestamp}] [Chunk {chunk_num}] [{lang}→EN]\n{text}\n" + "-"*60 + "\n"

    with open(filepath, "a", encoding="utf-8") as f:
        f.write(line)

    # Show on screen (truncate long lines for readability)
    preview = text[:150] + ("..." if len(text) > 150 else "")
    print(f"\n  [{timestamp}] [{lang}] {preview}")


# ─────────────────────────────────────────────────────────
#  SHARED STATE — read by both threads
# ─────────────────────────────────────────────────────────

state = {
    "running": True,   # set to False → recording loop exits
    "paused":  False,  # set to True  → chunks recorded but discarded
}

import queue
audio_queue = queue.Queue()


# ─────────────────────────────────────────────────────────
#  KEYBOARD LISTENER — runs in background thread
#  P = pause/resume
#  S = stop
#  Type the letter then press Enter
# ─────────────────────────────────────────────────────────

def keyboard_listener():
    print("\n  CONTROLS (type letter + Enter):")
    print("  +-------------------------------------+")
    print("  |  P  =  Pause / Resume               |")
    print("  |  S  =  Stop and save transcript     |")
    print("  +-------------------------------------+\n")

    while state["running"]:
        try:
            key = input().strip().lower()
            if key == "p":
                state["paused"] = not state["paused"]
                msg = "PAUSED - discarding audio" if state["paused"] else "RESUMED - recording"
                print(f"\n  {'[PAUSED]' if state['paused'] else '[PLAY]'}  {msg}\n")
            elif key == "s":
                print("\n  Stopping after this chunk...\n")
                state["running"] = False
        except (EOFError, KeyboardInterrupt):
            state["running"] = False


# ─────────────────────────────────────────────────────────
#  MAIN RECORDING LOOP
#  Records at 48000 Hz → resamples to 16000 → transcribes
#  Overlap: carries last 2 seconds into next chunk
#  so words at boundaries are never cut off
# ─────────────────────────────────────────────────────────

def record_worker():
    chunk_samples_48k = CHUNK_SECONDS * RECORD_RATE
    while state["running"]:
        audio_48k = sd.rec(
            chunk_samples_48k,
            samplerate=RECORD_RATE,
            channels=CHANNELS,
            dtype="int16",
            device=MIC_DEVICE
        )
        sd.wait()  # block until recording finishes
        if not state["paused"] and state["running"]:
            audio_queue.put(audio_48k)

def run_transcription_loop(model: WhisperModel, transcript_path: Path):
    overlap_samples_16k = OVERLAP_SECS * WHISPER_RATE
    chunk_num      = 0
    overlap_buffer = np.array([], dtype=np.int16)

    print(f"  Transcript: {transcript_path}")
    if RECORD_RATE == WHISPER_RATE:
        print(f"  Mic device: {MIC_DEVICE} ({RECORD_RATE} Hz native)")
    else:
        print(f"  Mic device: {MIC_DEVICE} ({RECORD_RATE} Hz -> resampled to {WHISPER_RATE} Hz)")
    print(f"  Recording started in background...\n")

    while state["running"] or not audio_queue.empty():
        try:
            audio_48k = audio_queue.get(timeout=1.0)
        except queue.Empty:
            continue

        chunk_num += 1
        timestamp = datetime.now().strftime("%H:%M:%S")

        audio_48k_flat = audio_48k.flatten()

        if RECORD_RATE == WHISPER_RATE:
            audio_16k = audio_48k_flat
        else:
            audio_16k = resample_to_whisper(audio_48k_flat)

        if len(overlap_buffer) > 0:
            audio_16k = np.concatenate([overlap_buffer, audio_16k])

        overlap_buffer = audio_16k[-overlap_samples_16k:]

        print(f"  Transcribing chunk {chunk_num} (Queue: {audio_queue.qsize()})...", end="", flush=True)
        t0 = time.time()
        result = transcribe_chunk(model, audio_16k)
        print(f" {time.time()-t0:.1f}s")

        save_chunk(transcript_path, chunk_num, result, timestamp)

    print("\n  Recording stopped. Transcript saved.")


# ─────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────

def main():
    print("\n" + "="*60)
    print("  LECTURE TRANSCRIBER")
    print("  faster-whisper | offline | Urdu→English")
    print("="*60 + "\n")

    OUTPUT_DIR.mkdir(exist_ok=True)

    session  = datetime.now().strftime("%Y-%m-%d_%H-%M")
    out_path = OUTPUT_DIR / f"lecture_{session}.txt"

    # Write file header
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("LECTURE TRANSCRIPT\n")
        f.write(f"Date : {datetime.now().strftime('%A, %d %B %Y')}\n")
        f.write(f"Time : {datetime.now().strftime('%I:%M %p')}\n")
        f.write(f"Model: whisper-{MODEL_SIZE}\n")
        f.write("="*60 + "\n")

    print(f"  Transcript file: {out_path}")
    print(f"  Loading Whisper '{MODEL_SIZE}' model — please wait...\n")

    model = load_whisper_model()

    kb = threading.Thread(target=keyboard_listener, daemon=True)
    kb.start()

    rec_thread = threading.Thread(target=record_worker, daemon=True)
    rec_thread.start()

    try:
        run_transcription_loop(model, out_path)
    except KeyboardInterrupt:
        state["running"] = False
        print("\n  Stopped via Ctrl+C.")

    print(f"\n  Saved: {out_path}")

    # ── AUTO-SUMMARIZE ──────────────────────────────────────
    # Fire OpenClaw to summarize and send to Telegram
    send_to_openclaw(out_path)
    print()


if __name__ == "__main__":
    main()