from ytmusicapi import YTMusic


ytmusic = YTMusic()


def search(query, type):
    search_results = ytmusic.search(query, filter=type)
    results = []
    for res in search_results:
        results.append(
            {
                "title": res.get("title"),
                "videoId": res.get("videoId"),
                "duration": res.get("duration"),
                "thumbnails": (res.get("thumbnails") or [{}])[-1].get("url"),
                "url": res.get("url"),
                "author": res.get("artists"),
                "album": (res.get("album") or {}).get("name"),
                "views": res.get("views"),
            }
        )

    return results


if __name__ == "__main__":
    print(search("Oasis Wonderwall"))


