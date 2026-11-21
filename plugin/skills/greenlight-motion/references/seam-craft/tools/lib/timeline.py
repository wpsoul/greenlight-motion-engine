"""timeline.py — where items sit on a Video Editor timeline (shared by seam_check.py and seam_fit.py).

layout(channels, clips) -> [(channel, item, start_s, end_s, clip, transition_window_or_None)]
    Unsnapped channels: freeStart. A cross transition overlaps the item before it ("Next over previous", the default:
    this item is drawn transitionDuration earlier; "Previous over next": the window starts at this item). Snapped
    channels: one item after another, a cross transition overlapping by its duration. Times are the timeline's own
    seconds (inside a sequence: the sequence's inner time).
span(item) -> played length in seconds ((trimEnd - trimStart) / speed).
speed(item) -> the item's (first) playback speed.
clips(timeline) -> {clip id: clip} of a timeline (the project's data or a sequence's `sequence`).
"""


def clips(tl):
    return {c["id"]: c for c in tl.get("clips", [])}


def speed(it):
    sp = it.get("speedPoints")
    if sp and isinstance(sp[0], dict) and sp[0].get("y"): return float(sp[0]["y"])
    return float(it.get("speed") or 1) or 1.0


def span(it):
    return (float(it.get("trimEnd", 0)) - float(it.get("trimStart", 0) or 0)) / speed(it)


def layout(channels, clip_map):
    out = []
    for ch in channels:
        items = list(ch.get("items", []))
        unsnapped = ch.get("unsnapped") or any("freeStart" in it for it in items)
        if unsnapped: items.sort(key=lambda x: float(x.get("freeStart", 0) or 0))
        t, prev_end = 0.0, None
        for it in items:
            tr = it.get("transition")
            d = float(it.get("transitionDuration") or 0) if (tr and tr != "None") else 0.0
            a = float(it.get("freeStart", 0) or 0) if unsnapped else t
            tw = None
            if d > 0 and prev_end is not None:
                if it.get("transitionOrder") == "Previous over next":
                    tw = (a, a + d)
                else:
                    if not unsnapped or prev_end <= a + 1e-6: a = a - d
                    tw = (a, min(prev_end, a + d) if prev_end > a else a + d)
            b = a + span(it)
            out.append((ch, it, a, b, clip_map.get(it.get("clipId"), {}), tw))
            t, prev_end = b, b
    return out
