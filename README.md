## Instant Karaoke

AI‑powered karaoke web app that separates music into stems (vocals, drums, bass, other) and plays them back with synced lyrics. Works with YouTube links or local audio files.

### Features
- Real‑time stem separation with Demucs (PyTorch), chunked for low latency and cross‑faded for seamless full tracks
- YouTube search and streaming (ytmusicapi + yt‑dlp), or upload WAV/MP3/FLAC/M4A/OGG
- Web Audio player with per‑stem mute/volume, master dynamics, and tight A/V sync
- Synced lyrics via LRC (line and word‑level), adjustable offset, on‑video overlay
- Session management, temp file cleanup, and lightweight REST API (Flask)

### Tech Stack
- Backend: Python, Flask, PyTorch/Demucs, NumPy, SoundFile, pydub, yt‑dlp, ytmusicapi, syncedlyrics
- Frontend: HTML/CSS/ES6, Web Audio API
- Tools: ffmpeg (required on PATH)

### Prerequisites
- Python 3.9+ (≤ 3.12)
- ffmpeg installed and available on PATH (`ffmpeg -version`)

### Setup
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### Run
```bash
python run_app.py
# Visit http://localhost:8000
```

### Usage
1) YouTube: open the YouTube tab, search or paste a URL, pick a result. The app buffers chunks, starts playback, then stitches full stems for precise seeking.
2) Upload: switch to Upload, drag & drop an audio file. Playback starts as stems arrive.
3) Controls: toggle stems, adjust volumes, play/pause/seek. Use the lyrics refine form to fetch better LRC (artist/title) and the Word‑level toggle if available.

### API (brief)
- `POST /api/upload` – upload audio file; returns session info
- `GET /api/status/<session_id>` – processing status and ready chunks
- `GET /api/audio/<session_id>/<filename>` – serve chunk or full stem WAV
- `POST /api/yt/start/<video_id>` – start YouTube session (audio/video URLs via yt‑dlp)
- `GET /api/yt/search?q=...` – YouTube search results (ytmusicapi)
- `GET /api/lyrics?title=...&artist=...` – LRC text (syncedlyrics)
- `POST /api/cleanup/<session_id>` – remove temp files for a session

### Troubleshooting
- ffmpeg not found: install via your package manager and ensure `ffmpeg` is on PATH.
- Slow processing: CPU mode is default; enable CUDA if available for faster inference.
- YouTube failures: some videos/regions restrict extraction; try a different track or network.

### Acknowledgments
Demucs (Facebook Research), yt‑dlp, ytmusicapi, syncedlyrics, and ffmpeg.


