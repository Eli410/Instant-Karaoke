import os
import logging
import torch
import numpy as np
from typing import Dict, Optional

# Resolve model path relative to project root to be robust after moving files
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MODEL_PATH = os.path.join(PROJECT_ROOT, 'model', 'htdemucs.th')
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'


def load_model(model_name: str = 'htdemucs'):
    try:
        checkpoint = torch.load(
            MODEL_PATH,
            map_location='cpu',
            weights_only=False
        )

        model_class = checkpoint['klass']
        model_kwargs = checkpoint['kwargs']
        state_dict = checkpoint['state']

        model = model_class(**model_kwargs)
        model.load_state_dict(state_dict)
        model.eval()

        logging.info('Model loaded successfully, keeping on CPU for now')
        return model
    except Exception as e:
        raise Exception(f'Failed to initialize model: {e}')


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
        shifts: Number of random shifts for test-time augmentation (unused here).
        overlap: Overlap between chunks when splitting audio (unused here).
        split: Whether to split audio into chunks for processing (unused here).
        segment: Maximum segment length in seconds for processing (unused here).
        stem: Specific stem to extract. If None, extracts all stems.
        num_workers: Number of worker processes (unused here).

    Returns:
        Dictionary mapping stem names to their separated audio arrays as int16.
    """
    device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
    audio_tensor = torch.from_numpy(audio_array.copy()).view(-1, 2)
    audio_tensor = audio_tensor.float()
    waveform = audio_tensor.t()
    waveform /= 32768.0
    waveform *= 0.85  # Reduce volume to prevent clipping

    waveform = waveform.unsqueeze(0).to(device)
    model = model.to(device)

    with torch.no_grad():
        separated_sources = model(waveform)


    if hasattr(model, 'sources'):
        source_names = model.sources
    else:
        source_names = ['drums', 'bass', 'other', 'vocals']

    stem_outputs: Dict[str, np.ndarray] = {}

    if isinstance(separated_sources, torch.Tensor):
        for i, source_name in enumerate(source_names):
            if i < separated_sources.shape[1]:
                source_tensor = separated_sources[0, i]
                audio_track = source_tensor.transpose(0, 1).cpu().numpy()
                audio_track = np.clip(audio_track, -1, 1)
                audio_track = (audio_track * 32767).astype(np.int16)
                if stem is None or stem == source_name:
                    stem_outputs[source_name] = audio_track
    else:
        if hasattr(separated_sources, '__iter__') and not isinstance(separated_sources, torch.Tensor):
            for i, (source_tensor, source_name) in enumerate(zip(separated_sources, source_names)):
                if torch.is_tensor(source_tensor):
                    audio_track = source_tensor.transpose(0, 1).cpu().numpy()
                    audio_track = np.clip(audio_track, -1, 1)
                    audio_track = (audio_track * 32767).astype(np.int16)
                    if stem is None or stem == source_name:
                        stem_outputs[source_name] = audio_track

    return stem_outputs


def generate_audio_clip(duration_seconds: int = 3, samplerate: int = 44100, channels: int = 2):
    num_samples = int(duration_seconds * samplerate)
    audio = torch.randn(1, channels, num_samples, dtype=torch.float32)
    return audio


def main():
    model = load_model()
    samplerate = getattr(model, 'samplerate', 44100)
    channels = 2
    print(f'Device: {DEVICE}')
    print(f'Samplerate: {samplerate}, Channels: {channels}')
    duration_seconds = 3
    num_samples = int(duration_seconds * samplerate)
    audio_array = np.random.randint(-32768, 32767, size=(num_samples, 2), dtype=np.int16)
    print(f'Input audio shape: {audio_array.shape}')
    print(f'Input audio dtype: {audio_array.dtype}')
    separated_stems = process(audio_array, model, device=DEVICE)
    print('\nSeparated stems:')
    for stem_name, stem_audio in separated_stems.items():
        print(f' - {stem_name}: shape={stem_audio.shape}, dtype={stem_audio.dtype}')


if __name__ == '__main__':
    main()


