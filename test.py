import yt_dlp
import json

def get_audio_stream(youtube_url):
    """
    Extracts the direct audio and video stream URLs from a YouTube video using yt_dlp.
    Limits video quality to 720p maximum.

    Args:
        youtube_url (str): The YouTube video URL to extract streams from.

    Returns:
        dict: Dictionary containing video information and stream URLs.
    """
    ydl_opts = {
        'format': 'bestvideo[height<=720]+bestaudio/best[height<=720]',  # Limit to 720p
        'quiet': True,
        'no_warnings': True,
        'force_generic_extractor': True,
        'simulate': True,
        'noplaylist': True,
        'extract_flat': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(youtube_url, download=False)

    return info_dict


if __name__ == "__main__":
    url = "https://www.youtube.com/watch?v=lYBUbBu4W08"
    with open("info.json", "w") as f:
        json.dump(get_audio_stream(url), f, indent=4)


