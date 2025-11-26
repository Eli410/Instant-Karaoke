from ytmusicapi import YTMusic


ytmusic = YTMusic()


def search(query, type):
    search_results = ytmusic.search(query, filter=type)
    results = []
    for res in search_results:
        thumbs = res.get("thumbnails") or []
        thumb_url = None
        if thumbs:
            try:
                smallest = min(
                    thumbs,
                    key=lambda t: (t or {}).get("width") or (t or {}).get("height") or float("inf")
                )
                thumb_url = smallest.get("url")
            except Exception:
                thumb_url = thumbs[0].get("url")
        results.append(
            {
                "title": res.get("title"),
                "videoId": res.get("videoId"),
                "duration": res.get("duration"),
                "thumbnails": thumb_url,
                "url": res.get("url"),
                "author": res.get("artists"),
                "album": (res.get("album") or {}).get("name"),
                "views": res.get("views"),
            }
        )

    return results


if __name__ == "__main__":
    print(search("Imagine Dragons", "songs"))

