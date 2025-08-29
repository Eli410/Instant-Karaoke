from ytmusicapi import YTMusic


ytmusic = YTMusic()

def search(query):
    search_results = ytmusic.search(query)
    results = []
    for res in search_results:
        if res.get("resultType") == "song" or res.get("resultType") == "video":
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