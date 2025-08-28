import numpy as np
from pathlib import Path
import torch as th
from demucs.apply import apply_model, BagOfModels
from demucs.htdemucs import HTDemucs
from model import get_model, ModelLoadingError
from dora.log import fatal
import torch
import numpy as np

def load_model(model_name=None):
    """Load and prepare a demucs model for processing."""

    try:
        model = get_model(model_name)  
    except ModelLoadingError as error:
        fatal(error.args[0])

    model.cpu()
    model.eval()
    
    return model

def process(
    audio_array: np.ndarray,
    model,
    device=None,
    shifts=1,
    overlap=0.25,
    split=True,
    segment=None,
    stem=None,
    jobs=0,
):
    
    device = device or ("cuda" if th.cuda.is_available() else "cpu")

    # Validate segment length only if segment is specified
    if segment is not None:
        max_allowed_segment = float('inf')
        if isinstance(model, HTDemucs):
            max_allowed_segment = float(model.segment)
        elif isinstance(model, BagOfModels):
            max_allowed_segment = model.max_allowed_segment
        if segment > max_allowed_segment:
            fatal("Cannot use a Transformer model with a longer segment "
                  f"than it was trained for. Maximum segment is: {max_allowed_segment}")

    # Validate stem only if specified
    if stem is not None and stem not in model.sources:
        fatal(
            'error: stem "{stem}" is not in selected model. STEM must be one of {sources}.'.format(
                stem=stem, sources=', '.join(model.sources)))

    # Reshape the audio array to stereo format
    audio_tensor = torch.from_numpy(audio_array.copy()).view(-1, 2)    
    audio_tensor = audio_tensor.float()
    wav = audio_tensor.t()


    wav /= 32768.0  # Scale int16 audio data to the range [-1, 1]


    sources = apply_model(model, wav[None], device=device, shifts=shifts,
                        split=split, overlap=overlap, progress=True,
                        num_workers=jobs, segment=segment)[0]

    out = {}
    
    for source, name in zip(sources, model.sources):
        # Transpose and convert to NumPy array
        track = source.transpose(0, 1).cpu().numpy()
        
        # Limit to [-1, 1] then apply headroom to avoid clipping
        track = np.clip(track, -1, 1)

        # Convert to int16 stereo frames (N, 2)
        track = (track * 32767).astype(np.int16)

        # Assign the processed track to the output dictionary as 2D array
        out[name] = track

    return out


if __name__ == "__main__":
    import time
    import random
    
    # Test parameters
    sample_rate = 44100
    duration = 5  # seconds
    num_samples = sample_rate * duration
    
    print("Generating test audio...")
    
    # Generate a 5-second stereo test audio with different frequencies for each channel
    t = np.linspace(0, duration, num_samples, False)
    
    # Left channel: 440 Hz sine wave (A4 note)
    left_channel = 0.3 * np.sin(2 * np.pi * 440 * t)
    
    # Right channel: 880 Hz sine wave (A5 note) 
    right_channel = 0.3 * np.sin(2 * np.pi * 880 * t)
    
    # Add some noise to make it more realistic
    noise_level = 0.05
    left_channel += noise_level * np.random.randn(num_samples)
    right_channel += noise_level * np.random.randn(num_samples)
    
    # Combine into stereo array
    test_audio = np.column_stack((left_channel, right_channel))
    
    # Convert to int16 format
    test_audio = (test_audio * 32767).astype(np.int16)
    
    print(f"Generated test audio: shape={test_audio.shape}, dtype={test_audio.dtype}")
    print(f"Duration: {duration} seconds, Sample rate: {sample_rate} Hz")
    
    # Load the model once
    print("\nLoading demucs model...")
    model = load_model('htdemucs')
    print("Model loaded successfully!")
    
    # Process the audio
    print("\nProcessing audio with demucs model...")
    start_time = time.time()
    
    try:
        result = process(
            audio_array=test_audio,
            model=model,
            device='cpu'  # Use CPU for testing
        )
        
        processing_time = time.time() - start_time
        print(f"Processing completed in {processing_time:.2f} seconds")
        
        # Verify the output
        print("\n=== VERIFICATION RESULTS ===")
        
        # Check if we got the expected stems
        expected_stems = ['drums', 'bass', 'other', 'vocals']
        print(f"Expected stems: {expected_stems}")
        print(f"Actual stems: {list(result.keys())}")
        
        # Verify all expected stems are present
        missing_stems = set(expected_stems) - set(result.keys())
        if missing_stems:
            print(f"❌ Missing stems: {missing_stems}")
        else:
            print("✅ All expected stems present")
        
        # Check the length of each track
        print(f"\nInput audio length: {len(test_audio)} samples ({len(test_audio) / sample_rate:.2f} seconds)")
        
        for stem_name, stem_audio in result.items():
            expected_length = len(test_audio) * 2  # Stereo flattened to mono
            actual_length = len(stem_audio)
            
            print(f"\n{stem_name.upper()}:")
            print(f"  Expected length: {expected_length} samples")
            print(f"  Actual length: {actual_length} samples")
            print(f"  Duration: {actual_length / sample_rate:.2f} seconds")
            
            if actual_length == expected_length:
                print("  ✅ Length matches expected")
            else:
                print("  ❌ Length mismatch!")
            
            # Check data type
            print(f"  Data type: {stem_audio.dtype}")
            if stem_audio.dtype == np.int16:
                print("  ✅ Correct data type (int16)")
            else:
                print("  ❌ Unexpected data type")
            
            # Check value range
            min_val = np.min(stem_audio)
            max_val = np.max(stem_audio)
            print(f"  Value range: [{min_val}, {max_val}]")
            
            if min_val >= -32768 and max_val <= 32767:
                print("  ✅ Values within int16 range")
            else:
                print("  ❌ Values outside int16 range!")
            
            # Check for non-zero content
            non_zero_ratio = np.count_nonzero(stem_audio) / len(stem_audio)
            print(f"  Non-zero ratio: {non_zero_ratio:.3f}")
            
            if non_zero_ratio > 0.1:  # At least 10% non-zero values
                print("  ✅ Track has significant content")
            else:
                print("  ⚠️  Track may be mostly silent")
        
        print(f"\n✅ Test completed successfully!")
        
    except Exception as e:
        print(f"❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()

