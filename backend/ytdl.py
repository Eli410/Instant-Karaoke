import yt_dlp


def get_audio_stream(youtube_url):
    """
    Extracts the direct audio stream URL from a YouTube video using yt_dlp.

    Args:
        youtube_url (str): The YouTube video URL to extract audio from.

    Returns:
        str: The direct audio stream URL.
    """
    ydl_opts = {
        'format': 'bestaudio/best',
        'quiet': True,
        'no_warnings': True,
        'force_generic_extractor': True,
        'simulate': True,
        'noplaylist': True,
        'extract_flat': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(youtube_url, download=False)
        audio_url = info_dict['url']

    return audio_url


if __name__ == "__main__":
    url = "https://www.youtube.com/watch?v=lYBUbBu4W08"
    print(get_audio_stream(url))


