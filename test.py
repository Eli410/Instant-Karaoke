import syncedlyrics


def search_lyrics(title, artist, enhanced=True, verbose=False):
    try:
        query = f"{title} {artist}".strip()
        lrc = syncedlyrics.search(query, enhanced=enhanced)
        if lrc:
            return lrc
        return None
    except Exception as e:
        raise Exception(f"Failed to search lyrics: {e}")


if __name__ == "__main__":
    lrc = search_lyrics("thunder", "imagine dragons", enhanced=True)
    print(lrc)

