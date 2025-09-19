from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import numpy as np
import os
import tempfile
import atexit
import uuid
from werkzeug.utils import secure_filename
import soundfile as sf
from pydub import AudioSegment
from .audio_separation import load_model, process
import threading
import time
from datetime import datetime, timedelta
from .ytmusic import search as yt_search
from .ytdl import get_streams
import subprocess
import io
from .lyrics import search_lyrics
from .pitch import pitch_shift_preview
import logging


app = Flask(
    __name__,
    static_folder=os.path.join(os.path.dirname(__file__), '..', 'frontend', 'static'),
    static_url_path='/static'
)
CORS(app)

# Reduce noisy request logs from Werkzeug/Flask in console
logging.getLogger('werkzeug').setLevel(logging.WARNING)
app.logger.setLevel(logging.WARNING)


model = None
model_lock = threading.Lock()
SESSIONS = {}

# =============================================================================
# CONFIGURATION: Adjust these values for testing and performance tuning
# =============================================================================
CHUNK_DURATION = 7.0  # Duration in seconds for each audio chunk (adjustable for testing)

ALLOWED_EXTENSIONS = {'wav', 'mp3', 'flac', 'm4a', 'ogg'}

TEMP_BASE_DIR = tempfile.mkdtemp(prefix='instant_karaoke_')
UPLOAD_FOLDER = os.path.join(TEMP_BASE_DIR, 'uploads')
PROCESSED_FOLDER = os.path.join(TEMP_BASE_DIR, 'processed')

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)


# Use system ffmpeg. Ensure ffmpeg is available on PATH.
FFMPEG_EXE = 'ffmpeg'
AudioSegment.converter = FFMPEG_EXE


def cleanup_temp_files():
    import shutil
    try:
        if os.path.exists(TEMP_BASE_DIR):
            shutil.rmtree(TEMP_BASE_DIR)
            logging.debug(f"Cleaned up temporary directory: {TEMP_BASE_DIR}")
    except Exception as e:
        logging.warning(f"Error cleaning up temp files: {e}")


def cleanup_session_files(session_id):
    import shutil
    try:
        session_folder = os.path.join(PROCESSED_FOLDER, session_id)
        if os.path.exists(session_folder):
            shutil.rmtree(session_folder)
            logging.debug(f"Cleaned up session folder: {session_id}")

        if session_id in SESSIONS and 'filepath' in SESSIONS[session_id]:
            filepath = SESSIONS[session_id]['filepath']
            if os.path.exists(filepath):
                os.remove(filepath)
                logging.debug(f"Cleaned up uploaded file: {filepath}")
    except Exception as e:
        logging.warning(f"Error cleaning up session {session_id}: {e}")


def cleanup_old_sessions():
    cutoff_time = datetime.now() - timedelta(hours=1)
    sessions_to_cleanup = []

    for session_id, session_data in SESSIONS.items():
        if session_data.get('created_at', datetime.now()) < cutoff_time:
            sessions_to_cleanup.append(session_id)

    for session_id in sessions_to_cleanup:
        cleanup_session_files(session_id)
        if session_id in SESSIONS:
            del SESSIONS[session_id]
        logging.debug(f"Auto-cleaned up old session: {session_id}")


def background_cleanup_task():
    while True:
        try:
            cleanup_old_sessions()
            time.sleep(3600)
        except Exception as e:
            logging.warning(f"Error in background cleanup: {e}")
            time.sleep(60)


atexit.register(cleanup_temp_files)

logging.info(f"Temporary files will be stored in: {TEMP_BASE_DIR}")
logging.info(f"Upload folder: {UPLOAD_FOLDER}")
logging.info(f"Processed folder: {PROCESSED_FOLDER}")


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def load_model_safe():
    global model
    with model_lock:
        if model is None:
            logging.info('Loading model...')
            model = load_model('htdemucs')
            logging.info('Model loaded successfully!')
        return model


def split_audio_into_chunks(audio_data, sample_rate, chunk_duration=CHUNK_DURATION):
    chunk_samples = int(sample_rate * chunk_duration)
    chunks = []
    for i in range(0, len(audio_data), chunk_samples):
        chunk = audio_data[i:i + chunk_samples]
        if len(chunk) == chunk_samples:
            chunks.append(chunk)
    return chunks


def load_audio(filepath):
    try:
        audio_data, sample_rate = sf.read(filepath, always_2d=True)
        if audio_data.shape[1] == 1:
            audio_data = np.repeat(audio_data, 2, axis=1)
        if audio_data.dtype != np.int16:
            audio_data = (audio_data * 32767).astype(np.int16)
        return audio_data, sample_rate
    except Exception as e:
        try:
            segment = AudioSegment.from_file(filepath)
            segment = segment.set_channels(2)
            sample_rate = segment.frame_rate
            samples = np.array(segment.get_array_of_samples())
            samples = samples.reshape((-1, 2))
            if segment.sample_width != 2:
                max_val = float(1 << (8 * segment.sample_width - 1))
                samples = (samples.astype(np.float32) / max_val * 32767).astype(np.int16)
            return samples, sample_rate
        except Exception as e2:
            raise RuntimeError(f"Failed to load audio: {e2}")


def crossfade_concat(parts: list, sample_rate: int, fade_ms: float = 10.0) -> np.ndarray:
    if not parts:
        return np.zeros((0, 2), dtype=np.int16)
    if len(parts) == 1:
        return parts[0]
    fade_len = max(1, int(sample_rate * (fade_ms / 1000.0)))
    float_parts = [p.astype(np.float32) / 32768.0 for p in parts]
    out = float_parts[0]
    for nxt in float_parts[1:]:
        if fade_len >= out.shape[0] or fade_len >= nxt.shape[0]:
            out = np.vstack([out, nxt])
            continue
        t = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)[:, None]
        fade_out = np.cos(t * np.pi * 0.5) ** 2
        fade_in = np.sin(t * np.pi * 0.5) ** 2
        overlap_out = out[-fade_len:] * fade_out
        overlap_in = nxt[:fade_len] * fade_in
        overlapped = overlap_out + overlap_in
        out = np.vstack([out[:-fade_len], overlapped, nxt[fade_len:]])
    out = np.clip(out, -1.0, 1.0)
    return (out * 32767.0).astype(np.int16)


@app.route('/')
def index():
    return send_from_directory(os.path.join(os.path.dirname(__file__), '..', 'frontend'), 'index.html')


@app.route('/api/upload', methods=['POST'])
def upload_audio():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400
    try:
        session_id = str(uuid.uuid4())
        session_folder = os.path.join(PROCESSED_FOLDER, session_id)
        os.makedirs(session_folder, exist_ok=True)
        filename = secure_filename(file.filename)
        base_name, ext = os.path.splitext(filename)
        unique_filename = f"{session_id}_{base_name}{ext}"
        filepath = os.path.join(UPLOAD_FOLDER, unique_filename)
        file.save(filepath)
        audio_data, sample_rate = load_audio(filepath)
        chunks = split_audio_into_chunks(audio_data, sample_rate)
        SESSIONS[session_id] = {
            'folder': session_folder,
            'sample_rate': sample_rate,
            'chunk_duration': CHUNK_DURATION,
            'total_chunks': len(chunks),
            'ready': {},
            'stems': set(),
            'done': False,
            'error': None,
            'created_at': datetime.now(),
            'filepath': filepath,
        }

        def process_session():
            try:
                mdl = load_model_safe()
                stem_buffers = {}
                for i, chunk in enumerate(chunks):
                    logging.debug(f"Processing chunk {i+1}/{len(chunks)} for session {session_id}")
                    separated = process(audio_array=chunk, model=mdl, device='cpu')
                    for stem_name, stem_audio in separated.items():
                        SESSIONS[session_id]['stems'].add(stem_name)
                        stem_filename = f"chunk_{i:03d}_{stem_name}.wav"
                        stem_path = os.path.join(session_folder, stem_filename)
                        sf.write(stem_path, stem_audio, sample_rate)
                        SESSIONS[session_id]['ready'].setdefault(stem_name, set()).add(i)
                        stem_buffers.setdefault(stem_name, []).append(stem_audio)
                for stem_name, parts in stem_buffers.items():
                    full = crossfade_concat(parts, sample_rate, fade_ms=10.0)
                    stem_filename = f"{stem_name}.wav"
                    stem_path = os.path.join(session_folder, stem_filename)
                    sf.write(stem_path, full, sample_rate)
                SESSIONS[session_id]['done'] = True
            except Exception as e:
                SESSIONS[session_id]['error'] = str(e)
            finally:
                try:
                    os.remove(filepath)
                except Exception:
                    pass

        threading.Thread(target=process_session, daemon=True).start()
        return jsonify({
            'session_id': session_id,
            'total_chunks': len(chunks),
            'sample_rate': sample_rate,
            'chunk_duration': CHUNK_DURATION
        })
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


@app.route('/api/audio/<session_id>/<filename>')
def get_audio_file(session_id, filename):
    session_folder = os.path.join(PROCESSED_FOLDER, session_id)
    return send_from_directory(session_folder, filename)

@app.route('/api/pitch_audio/<session_id>/<path:filename>')
def get_pitched_audio_file(session_id, filename):
    try:
        semitones_q = request.args.get('semitones', '0')
        semitones = float(semitones_q)
        session_folder = os.path.join(PROCESSED_FOLDER, session_id)
        file_path = os.path.join(session_folder, filename)
        if not os.path.exists(file_path):
            return jsonify({'error': 'file not found'}), 404
        # Fast path: no shift
        if abs(semitones) < 1e-6:
            return send_from_directory(session_folder, filename)
        # Load entire file, convert to stereo int16, then shift
        audio_data, sample_rate = sf.read(file_path, always_2d=True)
        if audio_data.shape[1] == 1:
            audio_data = np.repeat(audio_data, 2, axis=1)
        if audio_data.dtype != np.int16:
            audio_data = (audio_data * 32767).astype(np.int16)
        total_duration = float(audio_data.shape[0]) / float(sample_rate)
        wav_bytes = pitch_shift_preview(audio_data, sample_rate, semitones, start_s=0.0, dur_s=total_duration + 1.0)
        return app.response_class(wav_bytes, mimetype='audio/wav')
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


@app.route('/api/status/<session_id>')
def status(session_id):
    state = SESSIONS.get(session_id)
    if not state:
        return jsonify({'error': 'invalid session'}), 404
    return jsonify({
        'ready': {k: sorted(list(v)) for k, v in state['ready'].items()},
        'stems': sorted(list(state['stems'])),
        'total_chunks': state['total_chunks'],
        'sample_rate': state['sample_rate'],
        'chunk_duration': state['chunk_duration'],
        'done': state['done'],
        'error': state['error'],
    })


@app.route('/api/cleanup/<session_id>', methods=['POST'])
def cleanup_session(session_id):
    try:
        cleanup_session_files(session_id)
        if session_id in SESSIONS:
            del SESSIONS[session_id]
        return jsonify({'message': f'Session {session_id} cleaned up successfully'})
    except Exception as e:
        return jsonify({'error': f'Failed to clean up session: {e}'}), 500


@app.route('/api/health')
def health_check():
    return jsonify({'status': 'healthy', 'model_loaded': model is not None})


@app.route('/api/yt/search')
def yt_search_endpoint():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify({'error': 'missing q'}), 400
    try:
        def _dedupe(results_list):
            seen = set()
            deduped = []
            for r in results_list:
                key = r.get('videoId') or r.get('url') or r.get('title')
                if key and key not in seen:
                    seen.add(key)
                    deduped.append(r)
            return deduped

        videos = yt_search(query, 'videos') or []
        for r in videos:
            try:
                r['type'] = 'video'
            except Exception:
                pass
        songs = yt_search(query, 'songs') or []
        for r in songs:
            try:
                r['type'] = 'song'
            except Exception:
                pass
        songs = _dedupe(songs)[:7] 
        videos = _dedupe(videos)[:3]
        def _views_to_int(v):
            try:
                if v is None:
                    return 0
                if isinstance(v, (int, float)):
                    return int(v)
                s = str(v).strip().lower().replace('views', '').strip()
                s = s.replace(',', '')
                mult = 1
                if s.endswith('k'):
                    mult = 1_000
                    s = s[:-1]
                elif s.endswith('m'):
                    mult = 1_000_000
                    s = s[:-1]
                elif s.endswith('b'):
                    mult = 1_000_000_000
                    s = s[:-1]
                num = float(s)
                return int(num * mult)
            except Exception:
                return 0
        combined = songs + videos
        combined.sort(key=lambda x: _views_to_int(x.get('views')), reverse=True)
        return jsonify({'results': combined})
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


@app.route('/api/lyrics')
def lyrics_endpoint():
    title = request.args.get('title', '').strip()
    artist = request.args.get('artist', '').strip()
    if not title or not artist:
        return jsonify({'error': 'missing title or artist'}), 400
    try:
        lrc = search_lyrics(title=title, artist=artist)
        return jsonify({'lrc': lrc or ''})
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


@app.route('/api/pitch_preview/<session_id>')
def pitch_preview(session_id):
    try:
        semitones = float(request.args.get('semitones', '0'))
        start_s = float(request.args.get('start', '0'))
        dur_s = float(request.args.get('dur', '3'))
        state = SESSIONS.get(session_id)
        if not state:
            return jsonify({'error': 'invalid session'}), 404
        session_folder = state['folder']
        sr = state['sample_rate']
        # Try continuous full-length stems first (best UX)
        # Prefer 'instrumental' when available to simulate karaoke backing
        preferred = None
        start_for_file = start_s
        for name in ['instrumental', 'other', 'drums', 'bass']:
            p = os.path.join(session_folder, f"{name}.wav")
            if os.path.exists(p):
                preferred = p
                break

        if preferred is None:
            # Fall back to chunk-based preview: pick the right chunk near requested start time
            ready = state.get('ready', {})
            chunk_duration = float(state.get('chunk_duration', 5.0))
            # Choose a stem with available chunks, preferring instrumental-like content
            candidate_stems = []
            for nm in ['instrumental', 'other', 'drums', 'bass', 'accompaniment']:
                if nm in ready and ready[nm]:
                    candidate_stems.append(nm)
            if not candidate_stems:
                # If no preferred stems, pick any stem present
                for nm, idxs in ready.items():
                    if idxs:
                        candidate_stems.append(nm)
                        break

            if candidate_stems:
                stem_name = candidate_stems[0]
                desired_idx = max(0, int(start_s // max(0.001, chunk_duration)))
                available = sorted(list(ready.get(stem_name, set())))
                # Choose the nearest available chunk index to desired_idx
                if available:
                    idx = min(available, key=lambda i: abs(i - desired_idx))
                else:
                    idx = desired_idx
                p = os.path.join(session_folder, f"chunk_{idx:03d}_{stem_name}.wav")
                if os.path.exists(p):
                    preferred = p
                    base_time = idx * chunk_duration
                    start_for_file = max(0.0, start_s - base_time)
                else:
                    preferred = None

        if preferred is None:
            # last resort: any wav in folder (will likely be a chunk; use local start=0)
            for fn in os.listdir(session_folder):
                if fn.lower().endswith('.wav'):
                    preferred = os.path.join(session_folder, fn)
                    start_for_file = 0.0
                    break

        if preferred is None:
            return jsonify({'error': 'no audio available for preview'}), 400

        audio_data, sample_rate = sf.read(preferred, always_2d=True)
        if audio_data.shape[1] == 1:
            audio_data = np.repeat(audio_data, 2, axis=1)
        if audio_data.dtype != np.int16:
            audio_data = (audio_data * 32767).astype(np.int16)
        wav_bytes = pitch_shift_preview(audio_data, sample_rate, semitones, start_s=start_for_file, dur_s=dur_s)
        return app.response_class(wav_bytes, mimetype='audio/wav')
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


def _read_remote_chunk_wav(stream_url: str, start_s: float, duration_s: float, target_sr: int = 44100):
    cmd = [
        FFMPEG_EXE,
        '-ss', str(max(0.0, float(start_s))),
        '-t', str(float(duration_s)),
        '-i', stream_url,
        '-vn',
        '-ac', '2',
        '-ar', str(target_sr),
        '-f', 'wav',
        'pipe:1'
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if proc.returncode != 0:
            return None, None
        data = proc.stdout
        if not data:
            return None, None
        import soundfile as sf
        import numpy as np
        buf = io.BytesIO(data)
        audio_data, sr = sf.read(buf, always_2d=True)
        if audio_data.shape[1] == 1:
            audio_data = np.repeat(audio_data, 2, axis=1)
        if audio_data.dtype != np.int16:
            audio_data = (audio_data * 32767).astype(np.int16)
        return audio_data, sr
    except Exception:
        return None, None


@app.route('/api/yt/start/<video_id>', methods=['POST'])
def yt_start_session(video_id):
    try:
        youtube_url = f"https://www.youtube.com/watch?v={video_id}"
        streams = get_streams(youtube_url)
        audio_url = (streams or {}).get('audio_url')
        video_url = (streams or {}).get('video_url')
        session_id = str(uuid.uuid4())
        session_folder = os.path.join(PROCESSED_FOLDER, session_id)
        os.makedirs(session_folder, exist_ok=True)
        chunk_duration = CHUNK_DURATION
        target_sr = 44100
        SESSIONS[session_id] = {
            'folder': session_folder,
            'sample_rate': target_sr,
            'chunk_duration': chunk_duration,
            'total_chunks': 0,
            'ready': {},
            'stems': set(),
            'done': False,
            'error': None,
            'created_at': datetime.now(),
            'source': {
                'type': 'youtube',
                'video_id': video_id,
                'audio_url': audio_url,
                'video_url': video_url,
            },
        }

        def process_stream():
            try:
                mdl = load_model_safe()
                stem_buffers = {}
                chunk_index = 0
                while True:
                    start_time = chunk_index * chunk_duration
                    if not audio_url:
                        break
                    audio_chunk, sr = _read_remote_chunk_wav(audio_url, start_time, chunk_duration, target_sr)
                    if audio_chunk is None or len(audio_chunk) == 0:
                        break
                    separated = process(audio_array=audio_chunk, model=mdl, device='cpu')
                    for stem_name, stem_audio in separated.items():
                        SESSIONS[session_id]['stems'].add(stem_name)
                        stem_filename = f"chunk_{chunk_index:03d}_{stem_name}.wav"
                        stem_path = os.path.join(session_folder, stem_filename)
                        sf.write(stem_path, stem_audio, sr)
                        SESSIONS[session_id]['ready'].setdefault(stem_name, set()).add(chunk_index)
                        stem_buffers.setdefault(stem_name, []).append(stem_audio)
                    chunk_index += 1
                for stem_name, parts in stem_buffers.items():
                    full = crossfade_concat(parts, target_sr, fade_ms=10.0)
                    stem_filename = f"{stem_name}.wav"
                    stem_path = os.path.join(session_folder, stem_filename)
                    sf.write(stem_path, full, target_sr)
                SESSIONS[session_id]['total_chunks'] = chunk_index
                SESSIONS[session_id]['done'] = True
            except Exception as e:
                SESSIONS[session_id]['error'] = str(e)

        threading.Thread(target=process_stream, daemon=True).start()
        return jsonify({
            'session_id': session_id,
            'sample_rate': target_sr,
            'chunk_duration': chunk_duration,
            'source': {
                'audio_url': audio_url,
                'video_url': video_url,
            }
        })
    except Exception as e:
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500


if __name__ == '__main__':
    load_model_safe()
    cleanup_thread = threading.Thread(target=background_cleanup_task, daemon=True)
    cleanup_thread.start()
    logging.info('Started background cleanup task')
    app.run(debug=True, host='0.0.0.0', port=5000)


