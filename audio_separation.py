import torch
import numpy as np
from typing import Dict, Optional, Union

# Configuration
MODEL_PATH = "model/htdemucs.th"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

def load_model(model_name='htdemucs'):
    try:
        # Load the model checkpoint to CPU first to avoid device issues
        checkpoint = torch.load(
            MODEL_PATH,
            map_location='cpu',
            weights_only=False
        )
        
        # Create the model from checkpoint
        model_class = checkpoint['klass']
        model_kwargs = checkpoint['kwargs']
        state_dict = checkpoint['state']
        
        model = model_class(**model_kwargs)
        model.load_state_dict(state_dict)
        model.eval()
        
        # Keep model on CPU initially - will be moved to device in process() function
        print(f"Model loaded successfully, keeping on CPU for now")
            
        return model
        
    except Exception as e:
        raise Exception(f"Failed to initialize model: {e}")


def generate_audio_clip(duration_seconds=3, samplerate=44100, channels=2):
    """Generate a random audio clip tensor shaped as (batch, channels, samples)."""
    num_samples = int(duration_seconds * samplerate)
    audio = torch.randn(1, channels, num_samples, dtype=torch.float32)
    return audio


def process(
    audio_array: np.ndarray,
    model,
    device: Optional[str] = None,
    shifts: int = 1,
    overlap: float = 0.25,
    split: bool = True,
    segment: Optional[float] = None,
    stem: Optional[str] = None,
    num_workers: int = 0,
) -> Dict[str, np.ndarray]:
    """Separate audio into individual stems using a loaded model.
    
    Args:
        audio_array: Input stereo audio as int16 numpy array with shape (samples, 2).
        model: Loaded model for source separation.
        device: Processing device ('cuda' or 'cpu'). Auto-detected if None.
        shifts: Number of random shifts for test-time augmentation (unused in this implementation).
        overlap: Overlap between chunks when splitting audio (unused in this implementation).
        split: Whether to split audio into chunks for processing (unused in this implementation).
        segment: Maximum segment length in seconds for processing (unused in this implementation).
        stem: Specific stem to extract. If None, extracts all stems.
        num_workers: Number of worker processes for parallel processing (unused in this implementation).
        
    Returns:
        Dictionary mapping stem names to their separated audio arrays as int16.
    """
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    
    # Convert audio array to tensor and normalize
    audio_tensor = torch.from_numpy(audio_array.copy()).view(-1, 2)
    audio_tensor = audio_tensor.float()
    waveform = audio_tensor.t()
    waveform /= 32768.0  # Scale int16 audio data to the range [-1, 1]
    
    # Add batch dimension and move to device
    waveform = waveform.unsqueeze(0).to(device)
    
    # Move model to the same device as input
    model = model.to(device)
    
    # Debug: Print tensor shapes and device info
    print(f"Debug - Input waveform shape: {waveform.shape}, device: {waveform.device}")
    print(f"Debug - Model device: {next(model.parameters()).device}")
    
    # Apply the model to separate sources
    with torch.no_grad():
        separated_sources = model(waveform)
    
    # Debug: Print output shape and type
    print(f"Debug - Output type: {type(separated_sources)}")
    if isinstance(separated_sources, torch.Tensor):
        print(f"Debug - Output shape: {separated_sources.shape}")
    elif hasattr(separated_sources, '__len__'):
        print(f"Debug - Output length: {len(separated_sources)}")
        if len(separated_sources) > 0 and torch.is_tensor(separated_sources[0]):
            print(f"Debug - First element shape: {separated_sources[0].shape}")
    
    print("Debug - Finished model inference")
    
    # Get source names from model if available, otherwise use default
    if hasattr(model, 'sources'):
        source_names = model.sources
    else:
        source_names = ["drums", "bass", "other", "vocals"]
    
    # Process each separated source
    stem_outputs = {}
    
    # Handle different output formats
    if isinstance(separated_sources, torch.Tensor):
        # Standard tensor output: [batch, sources, channels, samples]
        for i, source_name in enumerate(source_names):
            if i < separated_sources.shape[1]:  # Check if this source exists
                # Get the source tensor
                source_tensor = separated_sources[0, i]  # Remove batch dimension
                
                # Transpose and convert to NumPy array
                audio_track = source_tensor.transpose(0, 1).cpu().numpy()
                
                # Limit to [-1, 1] to avoid clipping
                audio_track = np.clip(audio_track, -1, 1)

                # Convert back to int16 stereo format
                audio_track = (audio_track * 32767).astype(np.int16)

                # Store the processed track if stem is None or matches requested stem
                if stem is None or stem == source_name:
                    stem_outputs[source_name] = audio_track
    else:
        # Handle other output formats (list, tuple, etc.)
        if hasattr(separated_sources, '__iter__') and not isinstance(separated_sources, torch.Tensor):
            for i, (source_tensor, source_name) in enumerate(zip(separated_sources, source_names)):
                if torch.is_tensor(source_tensor):
                    # Transpose and convert to NumPy array
                    audio_track = source_tensor.transpose(0, 1).cpu().numpy()
                    
                    # Limit to [-1, 1] to avoid clipping
                    audio_track = np.clip(audio_track, -1, 1)

                    # Convert back to int16 stereo format
                    audio_track = (audio_track * 32767).astype(np.int16)

                    # Store the processed track if stem is None or matches requested stem
                    if stem is None or stem == source_name:
                        stem_outputs[source_name] = audio_track
    
    return stem_outputs


def main():
    """Test the model with a sample audio clip."""
    model = load_model()

    # Discover model settings if available
    samplerate = getattr(model, 'samplerate', 44100)
    # Force stereo input; Demucs expects 2-channel audio
    channels = 2

    print(f"Device: {DEVICE}")
    print(f"Samplerate: {samplerate}, Channels: {channels}")

    # Create a sample audio array (int16 format like audio_separation.py expects)
    duration_seconds = 3
    num_samples = int(duration_seconds * samplerate)
    # Generate random int16 audio data with shape (samples, 2)
    audio_array = np.random.randint(-32768, 32767, size=(num_samples, 2), dtype=np.int16)
    
    print(f"Input audio shape: {audio_array.shape}")
    print(f"Input audio dtype: {audio_array.dtype}")

    # Process the audio using our process function
    separated_stems = process(audio_array, model, device=DEVICE)

    # Print results in the same format as audio_separation.py
    print("\nSeparated stems:")
    for stem_name, stem_audio in separated_stems.items():
        print(f" - {stem_name}: shape={stem_audio.shape}, dtype={stem_audio.dtype}")


if __name__ == "__main__":
    main()
