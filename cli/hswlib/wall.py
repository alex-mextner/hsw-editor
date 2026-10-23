"""``hsw-editor wall ...``: list, new, show, apply, undo, redo, export, physics, delete (all via the daemon's HTTP API)."""

from __future__ import annotations

import argparse
from urllib.parse import quote
import json
import sys
from typing import Any, Callable

from .client import Api
from .errors import UsageError

ACTOR_KINDS = ("human", "agent", "cli")


def add_wall_parser(subs: Any) -> None:
    wall = subs.add_parser(
        "wall",
        help="list, create, inspect and edit walls through the running daemon",
        description="Wall verbs talk to the running daemon (hsw-editor start). Edits are ops from packages/core; "
        "see docs/api.md. Every edit is attributed (--actor) and recorded in the wall history.",
    )
    verbs = wall.add_subparsers(dest="wall_verb", metavar="VERB", required=True)

    def verb(name: str, help_text: str, handler: Callable[[argparse.Namespace], int]) -> argparse.ArgumentParser:
        parser = verbs.add_parser(name, help=help_text, description=help_text)
        parser.set_defaults(wall_handler=handler)
        parser.add_argument("--json", action="store_true", help="print the daemon's JSON response")
        parser.add_argument("--port", type=int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        return parser

    verb("list", "list walls (newest first)", wall_list)

    new = verb("new", "create an empty wall", wall_new)
    new.add_argument("name", help="wall name")
    new.add_argument("--id", help="wall id (default: slug of the name plus a random suffix)")
    new.add_argument("--cols", type=int, help="board columns (default 48)")
    new.add_argument("--rows", type=int, help="board rows per column (default 32)")

    show = verb("show", "show a wall: board, items, photos, models, warnings", wall_show)
    show.add_argument("id")

    apply = verb(
        "apply",
        "apply ops from a JSON file or stdin (-) as one atomic, undoable step",
        wall_apply,
    )
    apply.add_argument("id")
    apply.add_argument("file", help="ops JSON: one op, an array of ops, or {\"ops\": [...], \"baseRev\": N}; '-' = stdin")
    apply.add_argument("--base-rev", type=int, help="fail with exit 9 unless the wall is at exactly this rev")
    apply.add_argument("--actor", default="cli", help="who edits: human|agent|cli, optionally kind:name (default cli)")
    apply.add_argument("--label", help="label of the batch when several ops are applied")

    for name, text in (("undo", "undo the newest not-yet-undone step"), ("redo", "redo the last undone step")):
        parser = verb(name, text, wall_undo if name == "undo" else wall_redo)
        parser.add_argument("id")
        parser.add_argument("--base-rev", type=int, help="fail with exit 9 unless the wall is at exactly this rev")
        parser.add_argument("--actor", default="cli", help="who edits: human|agent|cli, optionally kind:name")

    export = verb("export", "dump a wall and its full history as JSON (stdout or --out FILE)", wall_export)
    export.add_argument("id")
    export.add_argument("--out", "-o", help="write to FILE instead of stdout")
    export.add_argument("--wall-only", action="store_true", help="only the wall document, without history")

    physics = verb(
        "physics",
        "how the tools hang on their holders: stability, problems and removal ergonomics",
        wall_physics,
    )
    physics.add_argument("id")
    physics.add_argument("--item", help="analyse only this tool item (the others stay in its way)")

    delete = verb("delete", "move a wall to the trash (walls/.trash/, recoverable by hand)", wall_delete)
    delete.add_argument("id")


def run_wall(args: argparse.Namespace, api: Api) -> int:
    return int(args.wall_handler(args, api))


# ---- verbs ----------------------------------------------------------------------------------------


def wall_list(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", "/api/walls")
    if args.json:
        return _dump(data)
    walls = data["walls"]
    if not walls:
        print("no walls yet: hsw-editor wall new <name>")
        return 0
    rows = [("ID", "REV", "ITEMS", "PHOTOS", "MODELS", "UPDATED", "NAME")]
    rows += [
        (w["id"], str(w["rev"]), str(w["items"]), str(w["photos"]), str(w["models"]), w["updatedAt"][:19], w["name"])
        for w in walls
    ]
    _table(rows)
    return 0


def wall_new(args: argparse.Namespace, api: Api) -> int:
    body: dict[str, Any] = {"name": args.name, "actor": {"kind": "cli"}}
    if args.id:
        body["id"] = args.id
    board = {key: value for key, value in (("cols", args.cols), ("rows", args.rows)) if value is not None}
    if board:
        body["board"] = board
    data = api.request("POST", "/api/walls", body)
    if args.json:
        return _dump(data)
    wall = data["wall"]
    print(f"created {wall['id']} ({wall['name']}), board {wall['board']['cols']}x{wall['board']['rows']}")
    return 0


def wall_show(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", f"/api/walls/{args.id}")
    if args.json:
        return _dump(data)
    wall = data["wall"]
    board = wall["board"]
    print(f"{wall['name']} ({wall['id']})  rev {wall['rev']}  board {board['cols']}x{board['rows']} cells")
    print(f"undo: {'yes' if data['canUndo'] else 'no'}  redo: {'yes' if data['canRedo'] else 'no'}")
    if wall["items"]:
        rows = [("ITEM", "KIND", "BANK/MODEL", "CELL", "POSE x,y,z", "ROT", "FLAGS")]
        for item in wall["items"]:
            cell = item.get("cell")
            pose = item["pose"]
            flags = ",".join(
                flag
                for flag, on in (("locked", item["locked"]), (item["source"]["type"], item["source"]["type"] != "manual"))
                if on
            )
            rows.append((
                item["id"],
                item["kind"],
                item.get("bankId") or item.get("modelRefId") or item.get("photoId") or "-",
                f"{cell['col']},{cell['row']}" if cell else "-",
                f"{pose['x']:.1f},{pose['y']:.1f},{pose['z']:.1f}",
                f"{pose['rotZ']:g}",
                flags or "-",
            ))
        _table(rows)
    else:
        print("no items")
    for photo in wall["photos"]:
        calibrated = "calibrated" if photo.get("calibration") else "uncalibrated"
        print(f"photo {photo['id']}  {photo['width']}x{photo['height']}  {photo['origin']}  {calibrated}  {photo['file']}")
    for model in wall["models"]:
        print(f"model {model['id']}  {model['status']}  {model['label']}")
    for warning in data["warnings"]:
        print(f"warning [{warning['code']}] {warning['message']}", file=sys.stderr)
    return 0


def wall_apply(args: argparse.Namespace, api: Api) -> int:
    body = _read_ops_body(args.file)
    if args.base_rev is not None:
        body["baseRev"] = args.base_rev
    body["actor"] = _parse_actor(args.actor)
    if args.label:
        body["label"] = args.label
    return _report_apply(args, api.request("POST", f"/api/walls/{args.id}/ops", body))


def wall_undo(args: argparse.Namespace, api: Api) -> int:
    return _report_apply(args, api.request("POST", f"/api/walls/{args.id}/undo", _undo_body(args)))


def wall_redo(args: argparse.Namespace, api: Api) -> int:
    return _report_apply(args, api.request("POST", f"/api/walls/{args.id}/redo", _undo_body(args)))


def wall_export(args: argparse.Namespace, api: Api) -> int:
    data = api.request("GET", f"/api/walls/{args.id}/export")
    payload = data["wall"] if args.wall_only else data
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(f"wrote {args.out} (rev {data['wall']['rev']}, {len(data['history'])} history entries)", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


def wall_physics(args: argparse.Namespace, api: Api) -> int:
    wall = quote(args.id, safe="")
    if args.item is not None:
        path = f"/api/walls/{wall}/items/{quote(args.item, safe='')}/physics"
    else:
        path = f"/api/walls/{wall}/physics"
    data = api.request("GET", path)
    if args.json:
        return _dump(data)
    print(f"{args.id}  rev {data['rev']}  {len(data['tools'])} tools judged, {data['flagged']} with problems")
    if data["tools"]:
        rows = [("TOOL", "HOLDER", "STATUS", "SCORE", "RATING")]
        for tool in data["tools"]:
            rows.append((tool["toolId"], tool["holderId"], tool["status"], f"{tool['score']:.2f}", f"{tool['rating']:.2f}"))
        _table(rows)
    for tool in data["tools"]:
        for problem in tool["problems"]:
            print(f"{tool['toolId']}  [{problem['severity']}] {problem['text']}")
    for skipped in data["skipped"]:
        print(f"{skipped['toolId']}  skipped: {skipped['reason']}")
    return 0


def wall_delete(args: argparse.Namespace, api: Api) -> int:
    data = api.request("DELETE", f"/api/walls/{args.id}")
    if args.json:
        return _dump(data)
    print(f"moved {args.id} to {data['trashedTo']}")
    return 0


# ---- helpers --------------------------------------------------------------------------------------


def _undo_body(args: argparse.Namespace) -> dict[str, Any]:
    body: dict[str, Any] = {"actor": _parse_actor(args.actor)}
    if args.base_rev is not None:
        body["baseRev"] = args.base_rev
    return body


def _report_apply(args: argparse.Namespace, data: dict[str, Any]) -> int:
    if args.json:
        return _dump(data)
    state = "changed" if data["changed"] else "no change"
    print(f"rev {data['rev']} ({state}): {_describe_op(data['op'])}")
    for warning in data["warnings"]:
        print(f"warning [{warning['code']}] {warning['message']}", file=sys.stderr)
    return 0


def _describe_op(op: dict[str, Any]) -> str:
    if op["type"] == "batch":
        label = f" '{op['label']}'" if op.get("label") else ""
        return f"batch{label} of {len(op['ops'])} ops"
    target = op.get("id") or op.get("itemId") or op.get("photoId") or (op.get("item") or {}).get("id") or ""
    return f"{op['type']} {target}".strip()


def _read_ops_body(source: str) -> dict[str, Any]:
    try:
        text = sys.stdin.read() if source == "-" else open(source, encoding="utf-8").read()
    except OSError as exc:
        raise UsageError(what=f"cannot read {source}", why=str(exc), fix="pass an existing file or '-' for stdin") from None
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise UsageError(what=f"{source} is not valid JSON", why=str(exc), fix="see docs/api.md for the op shapes") from None
    if isinstance(raw, list):
        return {"ops": raw}
    if isinstance(raw, dict) and "ops" in raw:
        return dict(raw)
    if isinstance(raw, dict) and "type" in raw:
        return {"ops": [raw]}
    raise UsageError(
        what=f"{source} holds no ops",
        why="expected an op object, an array of ops, or an object with an 'ops' array",
        fix='example: {"type": "rename", "name": "Garage"}',
    )


def _parse_actor(value: str) -> dict[str, str]:
    kind, _, name = value.partition(":")
    if kind not in ACTOR_KINDS:
        raise UsageError(what=f"invalid --actor {value!r}", why=f"kind must be one of {', '.join(ACTOR_KINDS)}", fix="--actor agent:omp")
    return {"kind": kind, **({"name": name} if name else {})}


def _dump(data: Any) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def _table(rows: list[tuple[str, ...]]) -> None:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip())
