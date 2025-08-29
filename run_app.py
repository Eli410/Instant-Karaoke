import os
import sys
from backend.app import app

if __name__ == '__main__':
    print("🎵 Instant Karaoke - Audio Separation Web App")
    print("=" * 50)
    print("Starting server...")
    print("Open your browser and go to: http://localhost:8000")
    print("Press Ctrl+C to stop the server")
    print("=" * 50)
    
    try:
        app.run(debug=True, host='0.0.0.0', port=8000)
    except KeyboardInterrupt:
        print("\n👋 Server stopped. Goodbye!")
    except Exception as e:
        print(f"❌ Error starting server: {e}")
        sys.exit(1)
