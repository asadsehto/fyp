LECTURE TRANSCRIBER — SETUP & USAGE GUIDE
==========================================

WHAT THIS DOES
--------------
Records your class lecture from the laptop microphone.
Every 30 seconds it transcribes what was said (Urdu + English).
Saves everything to a text file in the transcripts/ folder.
Press P to pause, S to stop when class ends.


STEP 1 — INSTALL FFMPEG (one time only)
----------------------------------------
1. Go to: https://ffmpeg.org/download.html
2. Click "Windows builds from gyan.dev"
3. Download: ffmpeg-release-essentials.zip
4. Extract it. You will get a folder like: ffmpeg-6.x-essentials_build/
5. Copy the bin/ folder path (e.g. C:\ffmpeg\bin)
6. Open: Start → search "Environment Variables" → Edit System Variables
7. Find "Path" → Edit → New → paste the bin/ folder path → OK
8. Open a NEW terminal and run: ffmpeg -version
   You should see version info. If yes, FFmpeg is installed.


STEP 2 — INSTALL PYTHON PACKAGES (one time only)
--------------------------------------------------
Open terminal in this folder and run:

    pip install -r requirements.txt

This installs:
  - faster-whisper  (the transcription model)
  - argostranslate  (offline Urdu→English translation)
  - sounddevice     (microphone recording)
  - numpy, scipy    (audio processing)

Takes 3–5 minutes. Downloads ~900 MB total on first run.


STEP 3 — FIRST RUN (model downloads automatically)
----------------------------------------------------
    python transcribe.py

On first run:
  - Whisper large-v3-turbo downloads (~800 MB) — takes 5–10 min on good internet
  - Urdu translation pack downloads (~50 MB)
  - Both are cached forever after this — no internet needed in class

On every run after that:
  - Loads from cache in ~20 seconds
  - Works completely offline


STEP 4 — USING IT IN CLASS
----------------------------
1. Run: python transcribe.py
2. Wait for "Recording started..."
3. Place the laptop near you — built-in mic is enough
4. Speak normally — Urdu, English, or mixed

Controls (type and press Enter):
  P  →  Pause recording (e.g. during student questions you don't want saved)
  S  →  Stop and save when class ends

Transcript is saved to: transcripts/lecture_YYYY-MM-DD_HH-MM.txt


WHAT THE TRANSCRIPT FILE LOOKS LIKE
-------------------------------------
LECTURE TRANSCRIPT
Date: Friday, 15 November 2024
Time: 09:30 AM
Model: whisper-large-v3-turbo
============================================================

[09:30:45] [Chunk 1] [UR]
URDU:    آج ہم recursion کے بارے میں پڑھیں گے
ENGLISH: Today we will study about recursion
------------------------------------------------------------

[09:31:15] [Chunk 2] [EN]
URDU:    So the function calls itself until the base case is reached
ENGLISH: So the function calls itself until the base case is reached
------------------------------------------------------------


RAM USAGE GUIDE
----------------
8 GB  RAM laptop  →  int8 mode (default) — works fine, ~2 GB used by model
16 GB RAM laptop  →  int8 mode still recommended — leaves plenty for other apps
GPU available     →  change COMPUTE_TYPE = "float16" in transcribe.py for faster speed


TROUBLESHOOTING
----------------
"No module named faster_whisper"  →  run: pip install faster-whisper
"PortAudio not found"             →  run: pip install sounddevice, restart terminal
"ffmpeg not found"                →  re-do Step 1 and open a new terminal
Transcription is slow             →  normal on CPU — 30 sec audio takes ~15–25 sec
Urdu not recognized               →  speak closer to mic, reduce background noise
