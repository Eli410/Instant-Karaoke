import io
import subprocess
import numpy as np
import torch
import soundfile as sf


def _to_tensor_int16_stereo(audio_i16: np.ndarray) -> torch.Tensor:
    if audio_i16.dtype != np.int16:
        audio_i16 = audio_i16.astype(np.int16)
    if audio_i16.ndim == 1:
        audio_i16 = np.stack([audio_i16, audio_i16], axis=-1)
    if audio_i16.shape[1] == 1:
        audio_i16 = np.repeat(audio_i16, 2, axis=1)
    x = torch.from_numpy(audio_i16).to(torch.float32) / 32768.0
    # shape [samples, channels] -> [channels, samples]
    return x.transpose(0, 1)


def _to_int16_numpy(wave: torch.Tensor) -> np.ndarray:
    # wave shape [channels, samples]
    wave = torch.clamp(wave, -1.0, 1.0)
    y = (wave.transpose(0, 1).cpu().numpy() * 32767.0).astype(np.int16)
    return y


def pitch_shift_preview(audio_i16: np.ndarray, sr: int, semitones: float,
                        start_s: float = 0.0, dur_s: float = 3.0) -> bytes:
    """
    Create a short pitch-shifted preview snippet as WAV bytes using ffmpeg.

    Parameters
    ----------
    audio_i16 : np.ndarray
        Stereo int16 array of the full track, shape [samples, 2].
    sr : int
        Sample rate.
    semitones : float
        Positive for up, negative for down.
    start_s : float
        Start time (seconds) of the preview excerpt.
    dur_s : float
        Duration (seconds) of the preview excerpt.

    Returns
    -------
    bytes
        WAV-encoded bytes of the shifted preview.
    """
    n0 = max(0, int(start_s * sr))
    n1 = min(audio_i16.shape[0], n0 + int(dur_s * sr))
    if n1 <= n0:
        # empty
        buf = io.BytesIO()
        sf.write(buf, np.zeros((0, 2), dtype=np.int16), sr, format='WAV', subtype='PCM_16')
        return buf.getvalue()

    clip = audio_i16[n0:n1]
    wave = _to_tensor_int16_stereo(clip)

    def _ffmpeg_pitch_shift(clip_i16: np.ndarray, sample_rate: int, n_steps: float) -> np.ndarray:
        try:
            factor = float(2.0 ** (n_steps / 12.0))
            # Compose ffmpeg filter chain: pitch shift by asetrate, then restore duration with atempo
            atempo = 1.0 / max(1e-6, factor)
            # atempo only supports 0.5..2.0; our factor range from 0.5..2.0 given +/-12 semitones
            filter_str = f"asetrate={sample_rate * factor},aresample={sample_rate},atempo={atempo}"
            # Encode input to WAV bytes for simplicity
            in_buf = io.BytesIO()
            sf.write(in_buf, clip_i16, sample_rate, format='WAV', subtype='PCM_16')
            in_bytes = in_buf.getvalue()
            cmd = [
                'ffmpeg',
                '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0',
                '-ac', '2', '-ar', str(sample_rate),
                '-af', filter_str,
                '-f', 'wav', 'pipe:1'
            ]
            proc = subprocess.run(cmd, input=in_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if proc.returncode != 0 or not proc.stdout:
                raise RuntimeError(proc.stderr.decode('utf-8', errors='ignore'))
            out_buf = io.BytesIO(proc.stdout)
            y, _ = sf.read(out_buf, always_2d=True)
            if y.shape[1] == 1:
                y = np.repeat(y, 2, axis=1)
            y_i16 = (np.clip(y, -1.0, 1.0) * 32767.0).astype(np.int16)
            # Ensure duration close to requested
            target_len = clip_i16.shape[0]
            if y_i16.shape[0] > target_len:
                y_i16 = y_i16[:target_len]
            elif y_i16.shape[0] < target_len:
                pad = np.zeros((target_len - y_i16.shape[0], 2), dtype=np.int16)
                y_i16 = np.vstack([y_i16, pad])
            return y_i16
        except Exception as ee:
            print(f'Debug - FFmpeg pitch shift failed: {ee}')
            return clip_i16

    try:
        if abs(float(semitones)) < 1e-6:
            out_i16 = clip
        else:
            out_i16 = _ffmpeg_pitch_shift(clip, sr, float(semitones))
    except Exception as e:
        print(f'Debug - Pitch shift preview failed: {e}')
        out_i16 = clip

    buf = io.BytesIO()
    sf.write(buf, out_i16, sr, format='WAV', subtype='PCM_16')
    return buf.getvalue()

