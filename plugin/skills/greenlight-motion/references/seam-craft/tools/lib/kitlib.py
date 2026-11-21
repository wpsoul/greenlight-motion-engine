"""kitlib — shared helpers of the Seam Craft tools (imported by them, not run).

- env(NAME): the Seam Craft environment variable $SEAM_<NAME>, else the older spelling $VRX_<NAME> (both work).
  Names in use: BOARD, PROJECT, WORK (work folder), CONFIG (run config JSON), EASINGS (a capabilities copy).
- cfg(args): an optional run config (a JSON file with any of board, project, work_dir, fps, width, height,
  media_root, media_url_prefix) from --config or $SEAM_CONFIG, with the command-line values on top (an explicit
  argument always wins over the config). Defaults: 30 fps, 1920×1080, the tools' assumptions.
- call(method, path, body): the GreenLight Dash API at $GREENLIGHT_API_BASE_URL (Bearer $GREENLIGHT_API_TOKEN when set).
- frame(d, f) / count_frames(d): frame folders named f0000.jpg, f0001.jpg … (ffmpeg -vsync 0 -start_number 0).
- media_path(url, cfg): a board media URL (/media/admin/<board>/…) as a local file through cfg media_root / media_url_prefix.
Nothing here spends money or sends anything off the computer except to the local board API.
"""
import json, os, sys, urllib.error, urllib.request


def env(name, default=None):
    """$SEAM_<name>, else $VRX_<name> (the older spelling), else default"""
    return os.environ.get("SEAM_" + name) or os.environ.get("VRX_" + name) or default


def add_config_arg(ap):
    ap.add_argument("--config", default=env("CONFIG"),
                    help="run config JSON with any of board, project, work_dir (default $SEAM_CONFIG)")
    return ap


def cfg(args=None, **over):
    """the config dict: file values, then any non-None keyword / argparse value of the same name on top"""
    path = getattr(args, "config", None) if args is not None else env("CONFIG")
    c = json.load(open(path)) if path else {}
    if args is not None:
        for k, v in vars(args).items():
            if v is not None and k != "config": c[k] = v
    for k, v in over.items():
        if v is not None: c[k] = v
    c.setdefault("fps", 30); c.setdefault("width", 1920); c.setdefault("height", 1080)
    return c


def base_url():
    b = os.environ.get("GREENLIGHT_API_BASE_URL")
    if not b: sys.exit("GREENLIGHT_API_BASE_URL is not set (the GreenLight Dash terminal sets it)")
    return b.rstrip("/")


def call(method, path, body=None, timeout=600, raw=False):
    h = {"Content-Type": "application/json"}
    if os.environ.get("GREENLIGHT_API_TOKEN"): h["Authorization"] = "Bearer " + os.environ["GREENLIGHT_API_TOKEN"]
    req = urllib.request.Request(base_url() + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        return data if raw else json.loads(data or b"null")


def media_path(url, c):
    """/media/admin/<board>/rel/file -> local path (cfg media_url_prefix -> media_root); absolute paths pass through"""
    if os.path.exists(url): return url
    pre = c.get("media_url_prefix", "").rstrip("/")
    if pre and url.split("?")[0].startswith(pre):
        return os.path.join(c["media_root"], url.split("?")[0][len(pre):].lstrip("/"))
    raise ValueError(f"cannot map {url} to a file: set media_url_prefix / media_root in the config")


def frame(d, f, ext=".jpg"):
    return os.path.join(d, f"f{f:04d}{ext}")


def count_frames(d, ext=".jpg"):
    return len([n for n in os.listdir(d) if n.startswith("f") and n.endswith(ext)])


def write_json(path, obj, indent=1):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f: json.dump(obj, f, indent=indent, ensure_ascii=False)


if __name__ == "__main__":       # a module, not a tool: --help prints what it offers
    print(__doc__)
