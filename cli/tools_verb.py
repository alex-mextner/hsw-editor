"""``hsw-editor tools list|classes|import|show|rm``: the user tool library through the daemon's HTTP API.

Kept out of ``hsw_editor.py`` (one ``register_verb`` line there). ``import`` uploads photos as an import draft, runs
the ``tools.analyze`` job (vision sidecar), prints the objects found and, with ``--add``, commits the accepted ones
to the library; without it the draft stays open for the UI wizard.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from hswlib.client import Api
from hswlib.errors import AgentToolError, MissingTargetError, UsageError

JOB_POLL_S = 0.5
JOB_TIMEOUT_S = 600.0
# refits (class override, real length) and commits render several generator builds and thumbnails per object
REFIT_TIMEOUT_S = 115.0  # just under the daemon's 120 s idle timeout (the commit route takes `keys` to split a huge draft)


def configure(subs: Any) -> None:
    tools = subs.add_parser(
        "tools",
        help="user tool library: list, import from photos, show, remove",
        description="Built-in tool classes (parametric generators) and the user library at "
        "~/.local/share/hsw-editor/tools/. Talks to the running daemon (hsw-editor start).",
    )
    verbs = tools.add_subparsers(dest="tools_verb", metavar="VERB", required=True)

    def verb(name: str, help_text: str) -> argparse.ArgumentParser:
        parser = verbs.add_parser(name, help=help_text, description=help_text)
        parser.add_argument("--json", action="store_true", help="print the daemon's JSON response")
        parser.add_argument("--port", type=int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        return parser

    verb("list", "list the user's tools (newest first)")
    classes = verb("classes", "list the built-in tool classes and their dimension parameters")
    classes.add_argument("class_id", nargs="?", help="show one class with ranges, defaults and presets")

    imp = verb("import", "add tools from photos (one tool in several photos, or several tools in one photo)")
    imp.add_argument("photos", nargs="+", help="photo files (JPEG, PNG, WebP, HEIC)")
    imp.add_argument("--single", action="store_true", help="every photo shows ONE tool (merged into one)")
    imp.add_argument("--mm-per-px", type=float, help="scale of the photo in mm per pixel")
    imp.add_argument(
        "--two-point",
        metavar="X1,Y1,X2,Y2",
        help="two photo points (px) a known distance apart; pair with --distance-mm",
    )
    imp.add_argument("--distance-mm", type=float, help="real distance of --two-point")
    imp.add_argument("--length-mm", type=float, help="real length of the tool (single mode: the one tool)")
    imp.add_argument("--name", help="name of the tool (single mode)")
    imp.add_argument("--class", dest="class_id", help="force a class (see: tools classes); 'generic' = loft")
    imp.add_argument("--tag", action="append", default=[], metavar="TAG", help="library tag for every found object (repeatable); the tool is filterable by it in the editor")
    imp.add_argument("--add", action="store_true", help="add every found object to the library; without it the draft is left for review in the editor")

    show = verb("show", "show one tool: class, dimensions, colours, files")
    show.add_argument("id")
    rm = verb("rm", "move a tool to the library trash (recoverable)")
    rm.add_argument("id")


def run(args: argparse.Namespace) -> int:
    api = Api(args.port)
    handlers = {
        "list": tools_list,
        "classes": tools_classes,
        "import": tools_import,
        "show": tools_show,
        "rm": tools_rm,
    }
    return int(handlers[args.tools_verb](args, api))


def _dump(data: Any) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def _table(rows: list[tuple[str, ...]]) -> None:
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(c.ljust(widths[i]) for i, c in enumerate(r)).rstrip())


def tools_list(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", "/api/tools")
    if args.json:
        return _dump(data)
    tools = data["tools"]
    if not tools:
        print("no custom tools yet: hsw-editor tools import <photo...>")
        return 0
    rows = [("ID", "CLASS", "LxWxT mm", "CONF", "CREATED", "TAGS", "NAME")]
    for t in tools:
        d = t["dimensionsMm"]
        name = t["name"].get("en") or t["name"].get("ru") or "-"
        rows.append(
            (
                t["id"],
                t["classId"] or "generic",
                f"{d['length']:.0f}x{d['width']:.0f}x{d['thickness']:.0f}",
                f"{t['confidence']:.2f}",
                t["createdAt"][:19],
                ",".join(t["tags"]) or "-",
                name,
            )
        )
    _table(rows)
    return 0


def tools_classes(args: argparse.Namespace, api: Api) -> int:
    if args.class_id:
        data = api.request("GET", f"/api/tools/classes/{args.class_id}")
        if args.json:
            return _dump(data)
        print(f"{data['id']}  ({data['name']['en']} / {data['name']['ru']})  family {data['family']}  bank class {data['bankClass']}")
        rows = [("PARAM", "DEFAULT", "RANGE / OPTIONS", "LABEL")]
        for key, spec in data["schema"].items():
            if spec["kind"] == "num":
                rows.append((key, f"{spec['def']:g}", f"{spec['min']:g}..{spec['max']:g} {spec['unit']}", spec["label"]["en"]))
            elif spec["kind"] == "choice":
                rows.append((key, spec["def"], "|".join(spec["options"]), spec["label"]["en"]))
            else:
                rows.append((key, spec["def"], "colour", spec["label"]["en"]))
        _table(rows)
        print("presets: " + ", ".join(p["id"] for p in data["presets"]))
        return 0
    data = api.request("GET", "/api/tools/classes")
    if args.json:
        return _dump(data)
    rows = [("CLASS", "FAMILY", "PRESETS", "NAME")]
    for c in data["classes"]:
        rows.append((c["id"], c["family"], str(len(c["presets"])), c["name"]["en"]))
    _table(rows)
    return 0


def tools_show(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", f"/api/tools/{args.id}")
    if args.json:
        return _dump(data)
    t = data["tool"]
    d = t["dimensionsMm"]
    print(f"{t['id']}  {t['name'].get('en') or t['name'].get('ru') or ''}")
    print(f"class      {t['classId'] or 'generic loft'}  ({t['fit']['method']}, fit IoU {t['fit']['iou']:.2f}, confidence {t['fit']['confidence']:.2f})")
    print("tags       " + (", ".join(t["tags"]) or "-"))
    print(f"size       {d['length']:.1f} x {d['width']:.1f} x {d['thickness']:.1f} mm  (dimensions from: {d['source']})")
    if t["classCandidates"]:
        print("candidates " + ", ".join(f"{c['classId']} {c['score']:.2f}" for c in t["classCandidates"]))
    if t["partColors"]:
        print("colours    " + ", ".join(f"{k} {v}" for k, v in t["partColors"].items()))
    print(f"model      {t['model']['triangles']} triangles  files: /api/tools/{t['id']}/model.glb, thumb.webp")
    print(f"sources    {len(t['sources'])} file(s)")
    return 0


def tools_rm(args: argparse.Namespace, api: Api) -> int:
    data = api.request("DELETE", f"/api/tools/{args.id}")
    if args.json:
        return _dump(data)
    print(f"moved {args.id} to {data['trashedTo']}")
    return 0


# ---- import ---------------------------------------------------------------------------------------


def _multipart(fields: dict[str, str], files: list[Path]) -> tuple[bytes, str]:
    boundary = "----hsw" + secrets.token_hex(12)
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        )
    for path in files:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        head = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="photo"; filename="{path.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode()
        parts.append(head + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def _upload(api: Api, fields: dict[str, str], files: list[Path]) -> dict[str, Any]:
    body, boundary = _multipart(fields, files)
    req = urllib.request.Request(
        api.base + "/api/tools/drafts",
        data=body,
        method="POST",
        headers={"content-type": f"multipart/form-data; boundary={boundary}", "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise api._http_error(exc.code, exc.read(), "/api/tools/drafts") from None
    except urllib.error.URLError as exc:
        api.request("GET", "/api/health")  # raises the standard NotRunningError with the fix text
        raise UsageError(what="upload failed", why=str(exc.reason), fix="hsw-editor status") from None


def _wait_job(api: Api, job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + JOB_TIMEOUT_S
    last = ""
    while time.monotonic() < deadline:
        job = api.request("GET", f"/api/jobs/{job_id}")["job"]
        message = (job.get("progress") or {}).get("message") or job["state"]
        if message != last:
            print(f"  {message}", file=sys.stderr)
            last = message
        if job["state"] in ("succeeded", "failed", "cancelled"):
            return job
        time.sleep(JOB_POLL_S)
    raise AgentToolError(what="the import job did not finish in time", why=f"job {job_id}", fix=f"follow the job: GET /api/jobs/{job_id}, then review the draft in the editor")


def tools_import(args: argparse.Namespace, api: Api) -> int:
    files = [Path(p).expanduser() for p in args.photos]
    for f in files:
        if not f.is_file():
            raise MissingTargetError(what=f"no such photo: {f}", why="", fix="pass existing photo files")
    fields: dict[str, str] = {"mode": "single" if args.single else "multi"}
    calibration: dict[str, Any] = {}
    if args.mm_per_px:
        calibration["mmPerPx"] = args.mm_per_px
    if args.two_point:
        try:
            x1, y1, x2, y2 = (float(v) for v in args.two_point.split(","))
        except ValueError:
            raise UsageError(what="--two-point needs four numbers X1,Y1,X2,Y2", why=args.two_point, fix="e.g. --two-point 100,200,900,210 --distance-mm 240") from None
        if not args.distance_mm:
            raise UsageError(what="--two-point needs --distance-mm", why="", fix="add --distance-mm <real distance>")
        calibration["pointsPx"] = [[x1, y1], [x2, y2]]
        calibration["distanceMm"] = args.distance_mm
    if calibration:
        fields["calibration"] = json.dumps(calibration)
    draft = _upload(api, fields, files)["draft"]
    print(f"draft {draft['id']}: {len(files)} photo(s), analysing ...", file=sys.stderr)
    job = api.request("POST", "/api/jobs", {"kind": "tools.analyze", "input": {"draftId": draft["id"]}})["job"]
    done = _wait_job(api, job["id"])
    if done["state"] != "succeeded":
        raise AgentToolError(what="photo analysis failed", why=done.get("error") or done["state"], fix="hsw-editor doctor (vision sidecar), then retry")
    draft = api.request("GET", f"/api/tools/drafts/{draft['id']}")["draft"]
    objects = [o for o in draft["objects"] if o["status"] != "discarded"]

    # apply the CLI decisions (class, name, real length) to every object; --add also accepts them
    for o in objects:
        patch: dict[str, Any] = {}
        if args.add:
            patch["status"] = "accepted"
        if args.class_id:
            patch["classId"] = None if args.class_id == "generic" else args.class_id
        if args.name and len(objects) == 1:
            patch["name"] = {"en": args.name, "ru": args.name}
        if args.tag:
            patch["tags"] = args.tag
        if args.length_mm and len(objects) == 1:
            patch["dimensionsMm"] = {"length": args.length_mm}
        if patch:
            api.request(
                "PATCH", f"/api/tools/drafts/{draft['id']}/objects/{o['key']}", patch, timeout=REFIT_TIMEOUT_S
            )
    if args.add or args.class_id or args.name or args.length_mm or args.tag:
        draft = api.request("GET", f"/api/tools/drafts/{draft['id']}")["draft"]
        objects = [o for o in draft["objects"] if o["status"] != "discarded"]

    if args.json and not args.add:
        return _dump({"draft": draft})
    if not args.json:
        _print_objects(draft, objects)
    if args.add:
        result = api.request("POST", f"/api/tools/drafts/{draft['id']}/commit", {}, timeout=REFIT_TIMEOUT_S)
        if args.json:
            return _dump(result)
        for t in result["tools"]:
            print(f"added {t['id']}  {t['classId'] or 'generic'}  {t['dimensionsMm']['length']:.0f} mm")
        for s in result["skipped"]:
            print(f"skipped {s['key']}: {s['reason']}", file=sys.stderr)
        return 0 if result["tools"] else 1
    print(f"\nreview in the editor (Tool Library > Add from photo) or add them now: re-run with --add. draft: {draft['id']}")
    return 0


def _print_objects(draft: dict[str, Any], objects: list[dict[str, Any]]) -> None:
    rows = [("KEY", "TOP CLASSES", "SIZE mm", "FIT", "NOTE")]
    for o in objects:
        top = ", ".join(f"{s['classId']} {s['score']:.2f}" for s in o["suggestions"][:3]) or "-"
        d = o["dimensionsMm"]
        size = f"{d['length']:.0f}x{d['width']:.0f}x{d['thickness']:.0f}" if d else "-"
        fit = f"{o['fit']['method']} {o['fit']['iou']:.2f}" if o["fit"] else "-"
        note = "needs scale: --mm-per-px or --two-point" if o["needsScale"] else ""
        rows.append((o["key"], top, size, fit, note))
    _table(rows)
    print(f"\n{len(objects)} object(s) in {len(draft['photos'])} photo(s)")


__all__ = ["configure", "run"]
