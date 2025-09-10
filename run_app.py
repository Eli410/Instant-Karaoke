import os
import sys
import urllib.request
import shutil
import tempfile


PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
MODEL_DIR = os.path.join(PROJECT_ROOT, 'model')
MODEL_FILENAME = 'htdemucs.th'
MODEL_PATH = os.path.join(MODEL_DIR, MODEL_FILENAME)
MODEL_URL = 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th'


def ensure_model_downloaded():
    try:
        os.makedirs(MODEL_DIR, exist_ok=True)
        if not os.path.exists(MODEL_PATH):
            print('Model file not found. Downloading model...')
            tmp_fd, tmp_path = tempfile.mkstemp(prefix='htdemucs_', suffix='.th', dir=MODEL_DIR)
            os.close(tmp_fd)
            try:
                with urllib.request.urlopen(MODEL_URL) as response, open(tmp_path, 'wb') as out_file:
                    shutil.copyfileobj(response, out_file)
                os.replace(tmp_path, MODEL_PATH)
                print(f'Model downloaded to: {MODEL_PATH}')
            finally:
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
        else:
            pass
    except Exception as e:
        print(f"❌ Failed to ensure model is available: {e}")
        sys.exit(1)


from backend.app import app

PORT = 8000

if __name__ == '__main__':
    print("🎵 Instant Karaoke - Audio Separation Web App")
    print("=" * 50)
    print("Starting server...")
    print(f"Open your browser and go to: http://localhost:{PORT}")
    print("Press Ctrl+C to stop the server")
    print("=" * 50)
    
    try:
        ensure_model_downloaded()
        app.run(debug=True, host='0.0.0.0', port=PORT)
    except KeyboardInterrupt:
        print("\n👋 Server stopped. Goodbye!")
    except Exception as e:
        print(f"❌ Error starting server: {e}")
        sys.exit(1)
