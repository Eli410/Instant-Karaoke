import syncedlyrics

def search_lyrics(title, artist, enhanced=False):
    try:

        lrc = syncedlyrics.search(f"{title} {artist}", enhanced=enhanced)
        if lrc:
            return lrc
        return None
    except Exception as e:
        raise Exception(f"Failed to search lyrics: {e}")

if __name__ == "__main__":
        lrc = search_lyrics("my universe", "Coldplay", enhanced=True)
        print(lrc)