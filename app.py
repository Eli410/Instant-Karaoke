from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import numpy as np
import os
import tempfile
import uuid
from werkzeug.utils import secure_filename
import soundfile as sf
from pydub import AudioSegment
from test import load_model, process
import threading
import time

app = Flask(
    __name__,
    static_folder='frontend/static',
    static_url_path='/static'
)
CORS(app)  # Enable CORS for frontend communication

# Global model instance
model = None
model_lock = threading.Lock()
SESSIONS = {}

# Configuration
UPLOAD_FOLDER = 'uploads'
PROCESSED_FOLDER = 'processed'
ALLOWED_EXTENSIONS = {'wav', 'mp3', 'flac', 'm4a', 'ogg'}

# Create directories if they don't exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def load_model_safe():
    """Thread-safe model loading"""
    global model
    with model_lock:
        if model is None:
            print("Loading model...")
            model = load_model('htdemucs')
            print("Model loaded successfully!")
        return model

def split_audio_into_chunks(audio_data, sample_rate, chunk_duration=5.0):
    """Split audio into 5-second chunks"""
    chunk_samples = int(sample_rate * chunk_duration)
    chunks = []
    
    for i in range(0, len(audio_data), chunk_samples):
        chunk = audio_data[i:i + chunk_samples]
        if len(chunk) == chunk_samples:  # Only add complete chunks
            chunks.append(chunk)
    
    return chunks

def load_audio(filepath):
    """Load audio from various formats and return int16 numpy stereo array and sample_rate.
    Tries soundfile first, then falls back to pydub for formats like MP3.
    """
    try:
        audio_data, sample_rate = sf.read(filepath, always_2d=True)
        # Ensure stereo
        if audio_data.shape[1] == 1:
            audio_data = np.repeat(audio_data, 2, axis=1)
        # Convert float to int16 range
        if audio_data.dtype != np.int16:
            audio_data = (audio_data * 32767).astype(np.int16)
        return audio_data, sample_rate
    except Exception as e:
        # Fallback to pydub (supports mp3/m4a/ogg if ffmpeg is installed)
        try:
            segment = AudioSegment.from_file(filepath)
            segment = segment.set_channels(2)
            sample_rate = segment.frame_rate
            samples = np.array(segment.get_array_of_samples())
            samples = samples.reshape((-1, 2))  # stereo
            # pydub arrays match sample width; ensure int16
            if segment.sample_width != 2:
                # Normalize to float, then to int16
                max_val = float(1 << (8 * segment.sample_width - 1))
                samples = (samples.astype(np.float32) / max_val * 32767).astype(np.int16)
            return samples, sample_rate
        except Exception as e2:
            raise RuntimeError(f"Failed to load audio: {e2}")

def crossfade_concat(parts: list, sample_rate: int, fade_ms: float = 10.0) -> np.ndarray:
    """Concatenate 2D int16 stereo parts with equal-power crossfade to avoid clicks and peaks.
    Returns int16 array of shape (N, 2).
    """
    if not parts:
        return np.zeros((0, 2), dtype=np.int16)
    if len(parts) == 1:
        return parts[0]

    fade_len = max(1, int(sample_rate * (fade_ms / 1000.0)))
    # Convert each part to float32 [-1, 1]
    float_parts = [p.astype(np.float32) / 32768.0 for p in parts]
    out = float_parts[0]
    for nxt in float_parts[1:]:
        if fade_len >= out.shape[0] or fade_len >= nxt.shape[0]:
            # If chunks are too short, just concatenate without fade
            out = np.vstack([out, nxt])
            continue
        # Equal-power fade using cosine curves
        t = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)[:, None]
        fade_out = np.cos(t * np.pi * 0.5) ** 2
        fade_in = np.sin(t * np.pi * 0.5) ** 2
        overlap_out = out[-fade_len:] * fade_out
        overlap_in = nxt[:fade_len] * fade_in
        overlapped = overlap_out + overlap_in
        out = np.vstack([out[:-fade_len], overlapped, nxt[fade_len:]])
    # Back to int16 with clipping
    out = np.clip(out, -1.0, 1.0)
    return (out * 32767.0).astype(np.int16)

@app.route('/')
def index():
    return send_from_directory('frontend', 'index.html')

# Static files are served by Flask's built-in static handler configured above

@app.route('/api/upload', methods=['POST'])
def upload_audio():
    """Upload and process audio file (background processing for early playback)."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400
    
    try:
        # Generate unique session ID
        session_id = str(uuid.uuid4())
        session_folder = os.path.join(PROCESSED_FOLDER, session_id)
        os.makedirs(session_folder, exist_ok=True)
        
        # Save uploaded file
        filename = secure_filename(file.filename)
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        file.save(filepath)
        
        # Load audio and split into chunks
        audio_data, sample_rate = load_audio(filepath)
        chunks = split_audio_into_chunks(audio_data, sample_rate)

        # Initialize session state and start background processing
        SESSIONS[session_id] = {
            'folder': session_folder,
            'sample_rate': sample_rate,
            'chunk_duration': 5.0,
            'total_chunks': len(chunks),
            'ready': {},  # stem_name -> set(indices)
            'stems': set(),
            'done': False,
            'error': None,
        }

        def process_session():
            try:
                mdl = load_model_safe()
                stem_buffers = {}
                for i, chunk in enumerate(chunks):
                    print(f"Processing chunk {i+1}/{len(chunks)} for session {session_id}")
                    separated = process(audio_array=chunk, model=mdl, device='cpu')
                    for stem_name, stem_audio in separated.items():
                        SESSIONS[session_id]['stems'].add(stem_name)
                        # write chunk file
                        stem_filename = f"chunk_{i:03d}_{stem_name}.wav"
                        stem_path = os.path.join(session_folder, stem_filename)
                        sf.write(stem_path, stem_audio, sample_rate)
                        SESSIONS[session_id]['ready'].setdefault(stem_name, set()).add(i)
                        # accumulate for final full file
                        stem_buffers.setdefault(stem_name, []).append(stem_audio)
                # write final continuous stems
                for stem_name, parts in stem_buffers.items():
                    full = crossfade_concat(parts, sample_rate, fade_ms=10.0)
                    stem_filename = f"{stem_name}.wav"
                    stem_path = os.path.join(session_folder, stem_filename)
                    sf.write(stem_path, full, sample_rate)
                SESSIONS[session_id]['done'] = True
            except Exception as e:
                SESSIONS[session_id]['error'] = str(e)
            finally:
                # remove uploaded file
                try:
                    os.remove(filepath)
                except Exception:
                    pass

        threading.Thread(target=process_session, daemon=True).start()

        return jsonify({
            'session_id': session_id,
            'total_chunks': len(chunks),
            'sample_rate': sample_rate,
            'chunk_duration': 5.0
        })
        
    except Exception as e:
        # Return a clear error message to the frontend
        return jsonify({'error': f'{type(e).__name__}: {e}'}), 500

@app.route('/api/audio/<session_id>/<filename>')
def get_audio_file(session_id, filename):
    """Serve processed audio files"""
    session_folder = os.path.join(PROCESSED_FOLDER, session_id)
    return send_from_directory(session_folder, filename)

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

@app.route('/api/health')
def health_check():
    """Health check endpoint"""
    return jsonify({'status': 'healthy', 'model_loaded': model is not None})

if __name__ == '__main__':
    # Pre-load the model on startup
    load_model_safe()
    
    app.run(debug=True, host='0.0.0.0', port=5000)
