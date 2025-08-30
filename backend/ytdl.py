import yt_dlp


def get_streams(youtube_url):
    """
    Extract direct audio and video stream URLs (video<=720p) using yt_dlp,
    mirroring the approach shown in test.py.

    Args:
        youtube_url (str): The YouTube video URL.

    Returns:
        dict: {
            'audio_url': str | None,
            'video_url': str | None,
            'video_height': int | None,
            'video_width': int | None,
            'fps': int | None,
            'audio_ext': str | None,
            'video_ext': str | None,
            'container': str | None,
        }
    """
    ydl_opts = {
        'format': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        'quiet': True,
        'no_warnings': True,
        'force_generic_extractor': True,
        'simulate': True,
        'noplaylist': True,
        'extract_flat': True,
    }
    audio_url = None
    video_url = None
    video_h = None
    video_w = None
    fps = None
    audio_ext = None
    video_ext = None
    container = None
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=False)
        # When format is X+Y, yt_dlp returns requested_formats with both entries
        requested = info.get('requested_formats') or []
        if isinstance(requested, list) and len(requested) >= 1:
            for fmt in requested:
                vext = (fmt.get('video_ext') or '').lower()
                aext = (fmt.get('audio_ext') or '').lower()
                if vext and vext != 'none':
                    video_url = fmt.get('url') or video_url
                    video_h = fmt.get('height') or video_h
                    video_w = fmt.get('width') or video_w
                    fps = fmt.get('fps') or fps
                    video_ext = fmt.get('ext') or video_ext
                    container = fmt.get('container') or container
                if aext and aext != 'none':
                    audio_url = fmt.get('url') or audio_url
                    audio_ext = fmt.get('ext') or audio_ext
        # Fallbacks if requested_formats missing
        if not audio_url and isinstance(info.get('url'), str):
            # Some flat extractions return a single URL; often audio-only for the chosen format
            audio_url = info.get('url')
        return {
            'audio_url': audio_url,
            'video_url': video_url,
            'video_height': video_h,
            'video_width': video_w,
            'fps': fps,
            'audio_ext': audio_ext,
            'video_ext': video_ext,
            'container': container,
        }


if __name__ == "__main__":
    url = "https://www.youtube.com/watch?v=lYBUbBu4W08"
    print(get_streams(url))


