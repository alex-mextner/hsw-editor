"""``hsw-editor bank ...``: add, list, show, rm, edit user-made bank elements (via the daemon's HTTP API).

Contract: docs/api.md "User elements", types in ``packages/bank/src/user.ts``. ``add`` is upload -> job
``bank.user.import`` -> poll; the daemon does the conversion, this module only builds the request and reports.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .client import Api
from .errors import AgentToolError, UsageError
from .wall import _dump, _table

MOUNTING_KINDS = ("hex-plug", "m3-screw", "clip", "none")
ANCHORS = ("back-bbox", "origin", "panel")
UNITS = ("auto", "mm", "cm", "m", "in")
AXES = ("+x", "-x", "+y", "-y", "+z", "-z")
IMPORT_JOB = "bank.user.import"
POLL_INTERVAL_S = 0.5
POLL_TIMEOUT_S = 300.0
TERMINAL_STATES = ("succeeded", "failed", "cancelled")

_NUMBER = r"-?\d+(?:\.\d+)?"
_DIM_RANGE = re.compile(rf"^([A-Za-z][A-Za-z0-9]*)=({_NUMBER})-({_NUMBER})$")


def add_bank_parser(subs: Any) -> None:
    bank = subs.add_parser(
        "bank",
        help="add, list, inspect, edit and remove your own bank elements (STL/GLB/3MF import)",
        description="User-made bank elements: a mesh is converted by the daemon into a normalised GLB in the wall frame "
        "and merged into the bank (ids my-*, source=user). Needs the running daemon; the converter needs `uv` "
        "(hsw-editor doctor).",
    )
    verbs = bank.add_subparsers(dest="bank_verb", metavar="VERB", required=True)

    def verb(name: str, help_text: str, handler: Callable[[argparse.Namespace, Api], int]) -> argparse.ArgumentParser:
        parser = verbs.add_parser(name, help=help_text, description=help_text)
        parser.set_defaults(bank_handler=handler)
        parser.add_argument("--json", action="store_true", help="print the daemon's JSON response")
        parser.add_argument("--port", type=int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        return parser

    add = verb("add", "import a mesh (.stl .glb .3mf, up to 100 MB) as a new bank element", bank_add)
    add.add_argument("file", nargs="?", help="mesh file; optional only with --replace (then the stored original is re-converted)")
    add.add_argument("--name", help="element name, used for both languages unless --name-ru/--name-en are given")
    add.add_argument("--name-ru", help="Russian name")
    add.add_argument("--name-en", help="English name")
    add.add_argument("--category", help="category id, e.g. accessories or hooks/wall (required unless --replace)")
    add.add_argument("--tag", action="append", default=[], metavar="TEXT", help="search tag for both languages (repeatable)")
    add.add_argument("--tag-ru", action="append", default=[], metavar="TEXT", help="search tag for the Russian index only (repeatable)")
    add.add_argument(
        "--tool-class",
        action="append",
        default=[],
        metavar="ID[:DIM=MIN-MAX,...][:capacity=N]",
        help="tool class the element holds, with optional size ranges in mm and capacity "
        "(repeatable), e.g. screwdriver:shaftDiameter=3-8:capacity=4",
    )
    add.add_argument("--part", metavar="ID", help="part (3MF object / glTF mesh) to import; '*' merges all (default: the biggest)")
    add.add_argument("--out", choices=AXES, help="source axis pointing away from the wall (needs --up; default: guessed)")
    add.add_argument("--up", choices=AXES, help="source axis pointing up on the wall (needs --out)")
    add.add_argument("--anchor", choices=ANCHORS, help="how the lattice phase is chosen (default back-bbox)")
    add.add_argument("--unit", choices=UNITS, help="unit of the source numbers (default auto)")
    add.add_argument("--no-repair", action="store_true", help="do not try to close holes / fix winding of a non-watertight mesh")
    add.add_argument(
        "--mounting",
        choices=MOUNTING_KINDS,
        help="mounting kind; cells are the ones detected for these settings (default: hex-plug, none for panels)",
    )
    add.add_argument("--id", help="wanted element id my-<kebab-case> (default from the name; a clash gets -2, -3, ...)")
    add.add_argument("--replace", metavar="ID", help="replace this user element (keeps its id); without FILE re-converts its stored original")

    verb("list", "list your elements: id, name, category, tags, size, footprint", bank_list).add_argument(
        "--all", action="store_true", help="the whole bank, with a source column (user|bank)"
    )

    verb("show", "show one user element: metadata, geometry, import settings", bank_show).add_argument("id")

    rm = verb("rm", "delete a user element", bank_rm)
    rm.add_argument("id")
    rm.add_argument("--force", action="store_true", help="delete even when walls still use the element (exit 9 otherwise)")

    edit = verb("edit", "change metadata of a user element (geometry untouched; re-import with `add --replace`)", bank_edit)
    edit.add_argument("id")
    edit.add_argument("--name", help="new name for both languages")
    edit.add_argument("--name-ru", help="new Russian name")
    edit.add_argument("--name-en", help="new English name")
    edit.add_argument("--category", help="new category id")
    edit.add_argument("--tag", action="append", default=None, metavar="TEXT", help="REPLACE the tags with these (both languages, repeatable)")
    edit.add_argument("--add-tag", action="append", default=None, metavar="TEXT", help="add a tag (both languages, repeatable)")


def run_bank(args: argparse.Namespace, api: Api) -> int:
    return int(args.bank_handler(args, api))


# ---- verbs ----------------------------------------------------------------------------------------


def bank_add(args: argparse.Namespace, api: Api) -> int:
    # everything that can be rejected locally is, before the first request
    file = _check_file(args)
    flags = _import_flags(args)
    created_upload: str | None = None
    try:
        replaced = api.request("GET", _element_path(args.replace)) if args.replace else None
        upload_id: str | None = None
        if file is not None:
            created_upload = upload_id = api.upload("/api/bank/user/uploads", file)["upload"]["id"]
        mounting = flags.pop("mountingKind", None)
        if mounting == "none":
            flags["mounting"] = {"kind": "none", "cells": []}
        elif mounting is not None:
            upload_id, created_upload = _preview_upload(api, args.replace, upload_id, created_upload)
            flags["mounting"] = _mounting_for(api, upload_id, flags.get("settings"), mounting)
        body = _import_body(flags, upload_id, replaced["element"] if replaced else None, args)
        job = api.request("POST", "/api/jobs", {"kind": IMPORT_JOB, "input": body})["job"]
        created_upload = None  # the job owns the upload from here on
        element = _await_job(api, job["id"], quiet=args.json)["element"]
    except AgentToolError:
        if created_upload is not None:
            _discard_upload(api, created_upload)
        raise
    if args.json:
        return _dump(element)
    print(f"{element['id']}  {element['name']['en']}  {element['category']}  {_dims(element)}")
    return 0


def bank_list(args: argparse.Namespace, api: Api) -> int:
    if args.all:
        data = api.request("GET", "/api/bank/index")
        if args.json:
            return _dump(data)
        rows = [("ID", "NAME", "SOURCE", "CATEGORY", "TAGS", "SIZE", "FOOTPRINT"), *(
            (el["id"], el["name"]["en"], el.get("source", "bank"), el["category"], _tags(el), _dims(el), _footprint(el))
            for el in data["elements"]
        )]
    else:
        data = api.request("GET", "/api/bank/user/elements")
        if args.json:
            return _dump(data)
        rows = [("ID", "NAME", "CATEGORY", "TAGS", "SIZE", "FOOTPRINT"), *(
            (el["id"], el["name"]["en"], el["category"], _tags(el), _dims(el), _footprint(el)) for el in data["elements"]
        )]
    if len(rows) == 1:
        print("no elements yet: hsw-editor bank add FILE --name TEXT --category ID", file=sys.stderr)
        return 0
    _table(rows)
    return 0


def bank_show(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", _element_path(args.id))
    if args.json:
        return _dump(data)
    el, meta = data["element"], data["meta"]
    mounting = el["mounting"]
    rows = [
        ("id", el["id"]),
        ("name", f"{el['name']['en']} / {el['name']['ru']}"),
        ("category", el["category"]),
        ("tags", f"en: {', '.join(el['tags']['en']) or '-'}; ru: {', '.join(el['tags']['ru']) or '-'}"),
        ("tool classes", ", ".join(el["toolClasses"]) or "-"),
        ("fits tool", "; ".join(_fits_tool(f) for f in el["fitsTool"]) or "-"),
        ("footprint", f"{len(el['footprint']['cells'])} cells ({el['footprint']['cols']} x {el['footprint']['rows']})"),
        ("mounting", f"{mounting['kind']}, {len(mounting['cells'])} cells"),
        ("size", _dims(el)),
        ("watertight", f"{'yes' if meta['watertight'] else 'no'}{' (repaired)' if meta['repaired'] else ''}"),
        ("original", f"{meta['originalName']} ({meta['format']}, {meta['sourceBytes']} bytes)"),
        ("created", meta["createdAt"]),
        ("updated", meta["updatedAt"]),
    ]
    width = max(len(key) for key, _ in rows)
    for key, value in rows:
        print(f"{key.ljust(width)}  {value}")
    for warning in meta["warnings"]:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


def bank_rm(args: argparse.Namespace, api: Api) -> int:
    data = api.request("DELETE", _element_path(args.id) + ("?force=1" if args.force else ""))
    if args.json:
        return _dump(data)
    print(f"removed {args.id}")
    return 0


def bank_edit(args: argparse.Namespace, api: Api) -> int:
    if all(value is None for value in (args.name, args.name_ru, args.name_en, args.category, args.tag, args.add_tag)):
        raise UsageError(
            what="nothing to change",
            why="no metadata flag given",
            fix="pass at least one of --name, --name-ru, --name-en, --category, --tag, --add-tag",
        )
    patch: dict[str, Any] = {}
    current: dict[str, Any] | None = None
    if args.name_ru is not None or args.name_en is not None or args.name is not None:
        names = {"ru": args.name_ru, "en": args.name_en}
        if args.name is not None:
            names = {lang: names[lang] if names[lang] is not None else args.name for lang in names}
        if names["ru"] is None or names["en"] is None:
            current = api.request("GET", _element_path(args.id))["element"]
            names = {lang: names[lang] if names[lang] is not None else current["name"][lang] for lang in names}
        patch["name"] = names
    if args.category is not None:
        patch["category"] = args.category
    if args.tag is not None or args.add_tag is not None:
        tags: list[str] | None = args.tag
        if tags is None:  # --add-tag alone extends each language's current list
            current = current or api.request("GET", _element_path(args.id))["element"]
            patch["tags"] = {
                lang: _merge(current["tags"][lang], args.add_tag) for lang in ("ru", "en")
            }
        else:
            both = _merge(tags, args.add_tag or [])
            patch["tags"] = {"ru": both, "en": both}
    data = api.request("PATCH", _element_path(args.id), patch)
    if args.json:
        return _dump(data)
    el = data["element"]
    print(f"{el['id']}  {el['name']['en']}  {el['category']}  {_dims(el)}")
    return 0


# ---- add helpers ----------------------------------------------------------------------------------


def _check_file(args: argparse.Namespace) -> Path | None:
    if args.file is None:
        if not args.replace:
            raise UsageError(what="no mesh file given", why="FILE is optional only with --replace", fix="hsw-editor bank add FILE --name TEXT --category ID")
        return None
    path = Path(args.file).expanduser()
    if not path.is_file():
        raise UsageError(what=f"mesh file not found: {args.file}", why="not an existing regular file", fix="pass the path of an .stl, .glb or .3mf file")
    return path


def _import_flags(args: argparse.Namespace) -> dict[str, Any]:
    """Request fields built from flags alone (no network). ``mountingKind`` is resolved to cells later."""
    flags: dict[str, Any] = {}
    names = {"ru": args.name_ru or args.name, "en": args.name_en or args.name}
    if names["ru"] or names["en"]:
        mirrored = names["ru"] or names["en"]
        flags["name"] = {"ru": names["ru"] or mirrored, "en": names["en"] or mirrored}
    elif not args.replace:
        raise UsageError(what="no element name", why="--name (or --name-ru/--name-en) is required", fix="add --name TEXT")
    if args.category:
        flags["category"] = args.category
    elif not args.replace:
        raise UsageError(what="no category", why="--category is required unless --replace", fix="add --category ID (hsw-editor bank list --all shows the ones in use)")
    if args.tag or args.tag_ru:
        flags["tags"] = {"ru": _merge(args.tag, args.tag_ru), "en": _merge(args.tag, [])}
    if args.tool_class:
        fits = [_parse_tool_class(spec) for spec in args.tool_class]
        flags["fitsTool"] = fits
        flags["toolClasses"] = _merge([fit["toolClass"] for fit in fits], [])
    settings: dict[str, Any] = {}
    if args.part:
        settings["partId"] = args.part
    if (args.out is None) != (args.up is None):
        raise UsageError(what="--out and --up go together", why="the orientation needs both axes", fix="pass both, e.g. --out +z --up +y")
    if args.out:
        settings["orient"] = {"out": args.out, "up": args.up}
    if args.anchor:
        settings["anchor"] = args.anchor
    if args.unit:
        settings["unit"] = args.unit
    if args.no_repair:
        settings["repair"] = False
    if settings:
        flags["settings"] = settings
    if args.id:
        flags["id"] = args.id
    if args.mounting:
        flags["mountingKind"] = args.mounting
    return flags


def _parse_tool_class(spec: str) -> dict[str, Any]:
    """``screwdriver:shaftDiameter=3-8,width=2-4:capacity=4`` -> a FitsTool object."""
    tool_class, *segments = spec.split(":")
    fit: dict[str, Any] = {"toolClass": tool_class}
    dims: dict[str, dict[str, float]] = {}
    for segment in segments:
        if segment.startswith("capacity="):
            value = segment.partition("=")[2]
            if not value.isdigit() or int(value) < 1:
                raise _bad_tool_class(spec, f"capacity must be a positive integer, got '{value}'")
            fit["capacity"] = int(value)
            continue
        for part in filter(None, segment.split(",")):
            match = _DIM_RANGE.match(part)
            if match is None:
                raise _bad_tool_class(spec, f"'{part}' is not DIM=MIN-MAX or capacity=N")
            low, high = float(match.group(2)), float(match.group(3))
            if low > high:
                raise _bad_tool_class(spec, f"'{part}': min is above max")
            dims[match.group(1)] = {"min": low, "max": high}
    if dims:
        fit["dims"] = dims
    return fit


def _bad_tool_class(spec: str, why: str) -> UsageError:
    return UsageError(
        what=f"invalid --tool-class '{spec}'",
        why=why,
        fix="use ID[:DIM=MIN-MAX,...][:capacity=N], e.g. screwdriver:shaftDiameter=3-8:capacity=4",
    )


def _preview_upload(
    api: Api, replace_id: str | None, upload_id: str | None, created: str | None
) -> tuple[str, str | None]:
    """The upload the mounting cells are previewed on; `--replace` without FILE re-opens the stored original for it."""
    if upload_id is not None:
        return upload_id, created
    reopened = api.request("POST", _element_path(replace_id) + "/reopen")["upload"]["id"]
    return reopened, reopened


def _mounting_for(api: Api, upload_id: str, settings: dict[str, Any] | None, kind: str) -> dict[str, Any]:
    """Mounting cells are the detected ones for these settings (the contract has no cells flag)."""
    preview = api.request("POST", f"/api/bank/user/uploads/{quote(upload_id)}/preview", settings or {})
    cells = preview["conversion"]["mountingCells"]
    if not cells:
        raise UsageError(
            what=f"no mounting cells detected for --mounting {kind}",
            why="the converted silhouette covers no honeycomb cell",
            fix="check --unit/--out/--up/--anchor, or use --mounting none",
        )
    return {"kind": kind, "cells": cells}


def _import_body(
    flags: dict[str, Any], upload_id: str | None, replaced: dict[str, Any] | None, args: argparse.Namespace
) -> dict[str, Any]:
    body = dict(flags)
    if upload_id is not None:
        body["uploadId"] = upload_id
    if args.replace:
        body["replaceId"] = args.replace
        # name and category are required by the job even when only re-converting: keep the stored ones
        if replaced is not None:
            body.setdefault("name", replaced["name"])
            body.setdefault("category", replaced["category"])
    return body


def _await_job(api: Api, job_id: str, quiet: bool) -> dict[str, Any]:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    last_message = ""
    while True:
        job = api.request("GET", f"/api/jobs/{quote(job_id)}")["job"]
        message = (job.get("progress") or {}).get("message") or ""
        if message and message != last_message and not quiet:
            print(message, file=sys.stderr)
        last_message = message or last_message
        state = job.get("state")
        if state == "succeeded":
            return job["result"]
        if state in TERMINAL_STATES:
            reason = job.get("error") or state
            raise AgentToolError(
                what=f"import {state}",
                why=reason if isinstance(reason, str) else str(reason),
                fix="check the file and the flags (hsw-editor bank add --help); a non-mesh or unit problem is the usual cause",
            )
        if time.monotonic() >= deadline:
            raise AgentToolError(
                what=f"import still running after {POLL_TIMEOUT_S:.0f}s",
                why=f"job {job_id} was not finished",
                fix=f"look at it later: GET /api/jobs/{job_id} (it keeps running in the daemon)",
            )
        time.sleep(POLL_INTERVAL_S)


def _discard_upload(api: Api, upload_id: str) -> None:
    """Best effort: a failed `add` must not leave its staged file behind; the original error is the one to report."""
    try:
        api.request("DELETE", f"/api/bank/user/uploads/{quote(upload_id)}")
    except AgentToolError:
        pass


# ---- formatting helpers ---------------------------------------------------------------------------


def _element_path(element_id: str) -> str:
    return f"/api/bank/user/elements/{quote(element_id, safe='')}"


def _merge(first: list[str], second: list[str] | None) -> list[str]:
    """Concatenate keeping order, dropping duplicates."""
    return list(dict.fromkeys([*first, *(second or [])]))


def _dims(element: dict[str, Any]) -> str:
    d = element["dimsMm"]
    return f"{d['x']:.1f}x{d['y']:.1f}x{d['z']:.1f} mm"


def _tags(element: dict[str, Any]) -> str:
    return ",".join(element["tags"]["en"]) or "-"


def _footprint(element: dict[str, Any]) -> str:
    fp = element["footprint"]
    return f"{fp['cols']}x{fp['rows']} ({len(fp['cells'])} cells)"


def _fits_tool(fit: dict[str, Any]) -> str:
    parts = [fit["toolClass"]]
    parts += [f"{key}={rng['min']:g}-{rng['max']:g}" for key, rng in (fit.get("dims") or {}).items()]
    if "capacity" in fit:
        parts.append(f"capacity={fit['capacity']}")
    return " ".join(parts)
