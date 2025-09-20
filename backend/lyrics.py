
import re, unicodedata
from typing import Optional, Union, Callable
from rapidfuzz import fuzz
import syncedlyrics
import syncedlyrics.utils as su  # adjust if the module path differs

def _normalize_text(s: Optional[str]) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _value_from_compare_key(item, compare_key):
    if isinstance(compare_key, str):
        return item.get(compare_key, "")
    return compare_key(item)

def _get_best_match_runtime(
    results: list,
    search_term: str,
    compare_key: Union[str, Callable[[dict], str]] = "name",
    min_score: int = 65,
):
    if not results or not search_term:
        return None

    q = _normalize_text(search_term)
    best = None
    best_tuple = None  # (final_score, base_score, -len(candidate), -idx)

    for idx, item in enumerate(results):
        cand_raw = _value_from_compare_key(item, compare_key)
        cand = _normalize_text(cand_raw)

        if not cand:
            composite = 0.0
            base = 0.0
        else:
            base = fuzz.token_set_ratio(cand, q)
            sort_s = fuzz.token_sort_ratio(cand, q)
            part_s = fuzz.partial_ratio(cand, q)
            composite = 0.6 * base + 0.25 * max(sort_s, part_s) + 0.15 * fuzz.ratio(cand, q)
            if cand.startswith(q):
                composite += 2.5
            if re.search(rf"\b{re.escape(q)}\b", cand):
                composite += 1.5
            composite -= min(6.0, abs(len(cand) - len(q)) * 0.25)

        composite = max(0.0, min(100.0, composite))
        rank_tuple = (composite, base, -len(cand), -idx)
        if (best_tuple is None) or (rank_tuple > best_tuple):
            best_tuple = rank_tuple
            best = item

    if not best or best_tuple[0] < float(min_score):
        return None
    return best

# 🔁 overwrite the library function
su.get_best_match = _get_best_match_runtime


def search_lyrics(title, artist, enhanced=True, providers=None):
    try:
        query = f"{title} {artist}".strip()
        if providers:
            lrc = syncedlyrics.search(query, enhanced=enhanced, providers=providers)
        else:
            lrc = syncedlyrics.search(query, enhanced=enhanced)
        if lrc:
            return lrc
        return None
    except Exception as e:
        raise Exception(f"Failed to search lyrics: {e}")


if __name__ == "__main__":
    lrc = search_lyrics("shallow", "lady gaga")
    print(lrc)

