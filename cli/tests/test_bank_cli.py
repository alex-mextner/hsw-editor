"""Tests of ``hsw-editor bank ...`` against a stdlib fake daemon that implements the user-element routes.

Nothing but the daemon is faked: the CLI runs in-process through ``hsw_editor.main`` and talks real HTTP over loopback.
Run: ``python3 -m unittest discover -s cli/tests`` (or pytest).
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

CLI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI_DIR))

import hsw_editor  # noqa: E402

BANK_ELEMENT_TEMPLATE: dict[str, Any] = {
    "category": "accessories",
    "tags": {"ru": [], "en": []},
    "toolClasses": [],
    "fitsTool": [],
    "footprint": {"cells": [{"dCol": 0, "dRow2": 0}], "cols": 1, "rows": 1},
    "bboxMm": {"min": {"x": 0, "y": 0, "z": 0}, "max": {"x": 40, "y": 20, "z": 10}},
    "dimsMm": {"x": 40, "y": 20, "z": 10},
    "mounting": {"kind": "hex-plug", "cells": [{"dCol": 0, "dRow2": 0}]},
}
CELLS = [{"dCol": 0, "dRow2": 0}, {"dCol": 1, "dRow2": 1}]


class FakeDaemon:
    """Mutable state plus a request log; the handler class reads it through the owning server."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []
        self.elements: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.polls: dict[str, int] = {}
        self.uploads: dict[str, dict[str, Any]] = {}
        self.deleted_uploads: list[str] = []
        self.walls_using: dict[str, list[dict[str, Any]]] = {}

    def seed(self, element_id: str, name: str, **extra: Any) -> None:
        self.elements[element_id] = {
            **BANK_ELEMENT_TEMPLATE,
            "id": element_id,
            "source": "user",
            "name": {"ru": name, "en": name},
            **extra,
        }

    def calls(self, method: str, prefix: str) -> list[Any]:
        return [body for m, path, body in self.requests if m == method and path.startswith(prefix)]


def _handler(daemon: FakeDaemon) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - base class signature
            pass

        def _reply(self, status: int, payload: Any) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _error(self, status: int, code: str, message: str, details: Any = None) -> None:
            self._reply(status, {"error": {"code": code, "message": message, "details": details}})

        def _body(self) -> bytes:
            return self.rfile.read(int(self.headers.get("content-length") or 0))

        def do_GET(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            daemon.requests.append(("GET", path, None))
            if path == "/api/bank/user/elements":
                return self._reply(200, {"elements": list(daemon.elements.values())})
            if path == "/api/bank/index":
                bank = {**BANK_ELEMENT_TEMPLATE, "id": "hsw-hook", "name": {"ru": "Крюк", "en": "Hook"}}
                return self._reply(200, {"elements": [bank, *daemon.elements.values()]})
            match = re.fullmatch(r"/api/bank/user/elements/([^/]+)", path)
            if match:
                element = daemon.elements.get(match.group(1))
                if element is None:
                    return self._error(404, "element_not_found", f"no user element {match.group(1)}")
                meta = {
                    "originalName": "holder.stl", "format": "stl", "sourceSha256": "0" * 64, "sourceBytes": 12,
                    "watertight": True, "repaired": False, "warnings": [],
                    "createdAt": "2026-10-23T10:00:00Z", "updatedAt": "2026-10-23T10:00:00Z",
                }
                return self._reply(200, {"element": element, "meta": meta})
            match = re.fullmatch(r"/api/jobs/([^/]+)", path)
            if match:
                return self._job(match.group(1))
            self._error(404, "not_found", path)

        def _job(self, job_id: str) -> None:
            job = daemon.jobs[job_id]
            daemon.polls[job_id] = daemon.polls.get(job_id, 0) + 1
            name = job["input"]["name"]["en"]
            if name == "Slow" and daemon.polls[job_id] == 1:
                return self._reply(200, {"job": {"id": job_id, "state": "running", "progress": {"message": "converting"}}})
            if name == "Boom":
                return self._reply(200, {"job": {"id": job_id, "state": "failed", "error": "mesh exploded"}})
            element_id = job["input"].get("replaceId") or job["input"].get("id") or "my-" + name.lower().replace(" ", "-")
            element = {**BANK_ELEMENT_TEMPLATE, "id": element_id, "source": "user", "name": job["input"]["name"],
                       "category": job["input"]["category"]}
            daemon.elements[element_id] = element
            self._reply(200, {"job": {"id": job_id, "state": "succeeded", "result": {"element": element, "conversion": {}}}})

        def do_POST(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            raw = self._body()
            if path == "/api/bank/user/uploads":
                return self._upload(raw)
            body = json.loads(raw) if raw else None
            daemon.requests.append(("POST", path, body))
            if re.fullmatch(r"/api/bank/user/uploads/[^/]+/preview", path):
                return self._reply(200, {"conversion": {"mountingCells": CELLS, "footprint": CELLS}})
            if re.fullmatch(r"/api/bank/user/elements/[^/]+/reopen", path):
                upload = {"id": "up-reopen01", "filename": "holder.stl"}
                return self._reply(201, {"upload": upload, "input": {}})
            if path == "/api/jobs":
                job_id = f"job{len(daemon.jobs) + 1}"
                daemon.jobs[job_id] = body
                return self._reply(202, {"job": {"id": job_id, "state": "queued"}})
            self._error(404, "not_found", path)

        def _upload(self, raw: bytes) -> None:
            filename = re.search(rb'name="file"; filename="([^"]*)"', raw)
            name = filename.group(1).decode() if filename else ""
            daemon.requests.append(("POST", "/api/bank/user/uploads", {"filename": name, "raw": raw}))
            if not name.lower().endswith((".stl", ".glb", ".3mf")):
                return self._error(415, "unsupported_media_type", f"{name} is not a supported mesh format")
            if b"BADMESH" in raw:
                return self._error(422, "mesh_unreadable", "the mesh has no triangles")
            upload = {"id": "up-abcdef01", "filename": name}
            daemon.uploads[upload["id"]] = upload
            self._reply(201, {"upload": upload})

        def do_PATCH(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            body = json.loads(self._body())
            daemon.requests.append(("PATCH", path, body))
            element = daemon.elements.get(path.rsplit("/", 1)[-1])
            if element is None:
                return self._error(404, "element_not_found", "no such element")
            element.update(body)
            self._reply(200, {"element": element})

        def do_DELETE(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            daemon.requests.append(("DELETE", self.path, None))
            if parts.path.startswith("/api/bank/user/uploads/"):
                daemon.deleted_uploads.append(parts.path.rsplit("/", 1)[-1])
                return self._reply(200, {"ok": True})
            element_id = parts.path.rsplit("/", 1)[-1]
            if element_id not in daemon.elements:
                return self._error(404, "element_not_found", "no such element")
            walls = daemon.walls_using.get(element_id)
            if walls and parse_qs(parts.query).get("force") != ["1"]:
                return self._error(409, "element_in_use", f"{element_id} is placed on walls", {"walls": walls})
            del daemon.elements[element_id]
            self._reply(200, {"ok": True})

    return Handler


class BankCliTest(unittest.TestCase):
    def setUp(self) -> None:
        if not hsw_editor.LIBS_OK:
            self.skipTest("agent-tools libs not importable (AGENT_TOOLS_LIB)")
        self.daemon = FakeDaemon()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self.daemon))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.mesh = Path(tmp.name) / "holder.stl"
        self.mesh.write_bytes(b"solid holder\nendsolid holder\n")

    def run_cli(self, *argv: str, port: int | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = hsw_editor.main(["--port", str(port or self.port), "bank", *argv])
            except SystemExit as exc:  # argparse usage errors
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    # ---- add ---------------------------------------------------------------------------------

    def test_add_uploads_submits_job_and_prints_the_element(self) -> None:
        code, out, _ = self.run_cli(
            "add", str(self.mesh), "--name", "Driver holder", "--category", "accessories",
            "--tag", "screwdriver", "--tag-ru", "отвёртка",
            "--tool-class", "screwdriver:shaftDiameter=3-8:capacity=4", "--tool-class", "pliers",
            "--part", "p1", "--out", "+z", "--up", "+y", "--anchor", "origin", "--unit", "mm", "--no-repair",
            "--id", "my-driver",
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "my-driver  Driver holder  accessories  40.0x20.0x10.0 mm")
        upload = self.daemon.calls("POST", "/api/bank/user/uploads")[0]
        self.assertEqual(upload["filename"], "holder.stl")
        self.assertIn(b"solid holder", upload["raw"])
        sent = self.daemon.jobs["job1"]
        self.assertEqual(
            sent,
            {
                "kind": "bank.user.import",
                "input": {
                    "name": {"ru": "Driver holder", "en": "Driver holder"},
                    "category": "accessories",
                    "tags": {"ru": ["screwdriver", "отвёртка"], "en": ["screwdriver"]},
                    "fitsTool": [
                        {"toolClass": "screwdriver", "dims": {"shaftDiameter": {"min": 3.0, "max": 8.0}}, "capacity": 4},
                        {"toolClass": "pliers"},
                    ],
                    "toolClasses": ["screwdriver", "pliers"],
                    "settings": {
                        "partId": "p1", "orient": {"out": "+z", "up": "+y"}, "anchor": "origin", "unit": "mm", "repair": False,
                    },
                    "id": "my-driver",
                    "uploadId": "up-abcdef01",
                },
            },
        )

    def test_add_mirrors_a_single_language_name(self) -> None:
        self.run_cli("add", str(self.mesh), "--name-ru", "Держатель", "--category", "accessories")
        self.assertEqual(self.daemon.jobs["job1"]["input"]["name"], {"ru": "Держатель", "en": "Держатель"})

    def test_add_mounting_uses_the_previewed_cells(self) -> None:
        code, _, _ = self.run_cli(
            "add", str(self.mesh), "--name", "Clip", "--category", "accessories", "--mounting", "clip", "--unit", "cm"
        )
        self.assertEqual(code, 0)
        self.assertEqual(self.daemon.calls("POST", "/api/bank/user/uploads/up-abcdef01/preview"), [{"unit": "cm"}])
        self.assertEqual(self.daemon.jobs["job1"]["input"]["mounting"], {"kind": "clip", "cells": CELLS})

    def test_add_mounting_none_needs_no_preview(self) -> None:
        self.run_cli("add", str(self.mesh), "--name", "Panel", "--category", "panels", "--mounting", "none")
        self.assertEqual(self.daemon.calls("POST", "/api/bank/user/uploads/up-abcdef01/preview"), [])
        self.assertEqual(self.daemon.jobs["job1"]["input"]["mounting"], {"kind": "none", "cells": []})

    def test_add_json_prints_the_element(self) -> None:
        code, out, _ = self.run_cli("add", str(self.mesh), "--name", "Holder", "--category", "accessories", "--json")
        self.assertEqual(code, 0)
        element = json.loads(out)
        self.assertEqual((element["id"], element["source"]), ("my-holder", "user"))

    def test_add_shows_progress_on_stderr(self) -> None:
        code, _, err = self.run_cli("add", str(self.mesh), "--name", "Slow", "--category", "accessories")
        self.assertEqual(code, 0)
        self.assertIn("converting", err)

    def test_add_progress_is_silent_with_json(self) -> None:
        _, _, err = self.run_cli("add", str(self.mesh), "--name", "Slow", "--category", "accessories", "--json")
        self.assertNotIn("converting", err)

    def test_add_failed_job_exits_1_with_the_reason(self) -> None:
        code, _, err = self.run_cli("add", str(self.mesh), "--name", "Boom", "--category", "accessories")
        self.assertEqual(code, 1)
        self.assertIn("mesh exploded", err)
        self.assertIn("fix:", err)

    def test_add_requires_name_and_category(self) -> None:
        self.assertEqual(self.run_cli("add", str(self.mesh), "--category", "accessories")[0], 2)
        self.assertEqual(self.run_cli("add", str(self.mesh), "--name", "X")[0], 2)
        self.assertEqual(self.daemon.requests, [])

    def test_add_missing_file_exits_2_before_any_request(self) -> None:
        code, _, err = self.run_cli("add", "/nonexistent/holder.stl", "--name", "X", "--category", "accessories")
        self.assertEqual(code, 2)
        self.assertIn("not found", err)
        self.assertEqual(self.daemon.requests, [])

    def test_add_without_file_needs_replace(self) -> None:
        code, _, _ = self.run_cli("add", "--name", "X", "--category", "accessories")
        self.assertEqual(code, 2)
        self.assertEqual(self.daemon.requests, [])

    def test_add_half_orientation_and_bad_tool_class_exit_2(self) -> None:
        base = ("add", str(self.mesh), "--name", "X", "--category", "accessories")
        self.assertEqual(self.run_cli(*base, "--out", "+z")[0], 2)
        self.assertEqual(self.run_cli(*base, "--tool-class", "screwdriver:shaft=big")[0], 2)
        self.assertEqual(self.run_cli(*base, "--tool-class", "screwdriver:capacity=0")[0], 2)
        self.assertEqual(self.daemon.requests, [])

    def test_add_unsupported_format_exits_2_with_a_fix(self) -> None:
        obj = self.mesh.with_name("holder.obj")
        obj.write_bytes(b"v 0 0 0")
        code, _, err = self.run_cli("add", str(obj), "--name", "X", "--category", "accessories")
        self.assertEqual(code, 2)
        self.assertIn(".stl .glb .3mf", err)

    def test_add_unreadable_mesh_exits_2(self) -> None:
        self.mesh.write_bytes(b"BADMESH")
        code, _, err = self.run_cli("add", str(self.mesh), "--name", "X", "--category", "accessories")
        self.assertEqual(code, 2)
        self.assertIn("no triangles", err)

    def test_add_replace_without_file_reconverts_the_stored_original(self) -> None:
        self.daemon.seed("my-x", "Old name")
        code, out, _ = self.run_cli("add", "--replace", "my-x", "--unit", "in")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("my-x  Old name  accessories"))
        self.assertEqual(self.daemon.calls("POST", "/api/bank/user/uploads"), [])
        sent = self.daemon.jobs["job1"]["input"]
        self.assertEqual(sent["replaceId"], "my-x")
        self.assertNotIn("uploadId", sent)
        self.assertEqual((sent["name"], sent["category"]), ({"ru": "Old name", "en": "Old name"}, "accessories"))

    def test_add_replace_with_file_sends_both_ids(self) -> None:
        self.daemon.seed("my-x", "Old name")
        self.run_cli("add", str(self.mesh), "--replace", "my-x", "--name", "New name")
        sent = self.daemon.jobs["job1"]["input"]
        self.assertEqual((sent["replaceId"], sent["uploadId"], sent["name"]["en"]), ("my-x", "up-abcdef01", "New name"))

    def test_add_replace_mounting_reopens_the_original_for_the_preview(self) -> None:
        self.daemon.seed("my-x", "Old name")
        self.run_cli("add", "--replace", "my-x", "--mounting", "m3-screw")
        sent = self.daemon.jobs["job1"]["input"]
        self.assertEqual(sent["uploadId"], "up-reopen01")
        self.assertEqual(sent["mounting"], {"kind": "m3-screw", "cells": CELLS})

    def test_add_replace_unknown_element_exits_5(self) -> None:
        code, _, err = self.run_cli("add", "--replace", "my-nope")
        self.assertEqual(code, 5)
        self.assertIn("hsw-editor bank list", err)

    # ---- list / show -------------------------------------------------------------------------

    def test_list_prints_user_elements_only(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0].split(), ["ID", "NAME", "CATEGORY", "TAGS", "SIZE", "FOOTPRINT"])
        self.assertTrue(lines[1].startswith("my-a"))
        self.assertNotIn("hsw-hook", out)

    def test_list_all_adds_the_source_column(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        code, out, _ = self.run_cli("list", "--all")
        self.assertEqual(code, 0)
        rows = {line.split()[0]: line.split() for line in out.splitlines()[1:]}
        self.assertEqual(rows["hsw-hook"][2], "bank")
        self.assertEqual(rows["my-a"][2], "user")

    def test_list_empty_points_to_add(self) -> None:
        code, out, err = self.run_cli("list")
        self.assertEqual((code, out), (0, ""))
        self.assertIn("bank add", err)

    def test_list_json_is_unchanged(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        _, out, _ = self.run_cli("list", "--json")
        self.assertEqual(json.loads(out), {"elements": list(self.daemon.elements.values())})

    def test_show_prints_details(self) -> None:
        self.daemon.seed("my-a", "Alpha", toolClasses=["screwdriver"],
                         fitsTool=[{"toolClass": "screwdriver", "dims": {"shaftDiameter": {"min": 3, "max": 8}}, "capacity": 4}])
        code, out, _ = self.run_cli("show", "my-a")
        self.assertEqual(code, 0)
        for text in ("my-a", "screwdriver shaftDiameter=3-8 capacity=4", "hex-plug, 1 cells", "holder.stl", "yes"):
            self.assertIn(text, out)

    def test_show_unknown_exits_5_with_a_hint(self) -> None:
        code, _, err = self.run_cli("show", "my-nope")
        self.assertEqual(code, 5)
        self.assertIn("hsw-editor bank list", err)

    # ---- rm / edit ---------------------------------------------------------------------------

    def test_rm_deletes(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        code, out, _ = self.run_cli("rm", "my-a")
        self.assertEqual((code, out.strip()), (0, "removed my-a"))
        self.assertNotIn("my-a", self.daemon.elements)

    def test_rm_in_use_exits_9_naming_the_walls_and_force_deletes(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        self.daemon.walls_using["my-a"] = [{"wallId": "garage", "items": ["i1", "i2"]}]
        code, _, err = self.run_cli("rm", "my-a")
        self.assertEqual(code, 9)
        self.assertIn("garage", err)
        self.assertIn("--force", err)
        self.assertIn("my-a", self.daemon.elements)
        code, _, _ = self.run_cli("rm", "my-a", "--force")
        self.assertEqual(code, 0)
        self.assertEqual(self.daemon.calls("DELETE", "/api/bank/user/elements/my-a?force=1"), [None])
        self.assertNotIn("my-a", self.daemon.elements)

    def test_rm_unknown_exits_5(self) -> None:
        self.assertEqual(self.run_cli("rm", "my-nope")[0], 5)

    def test_edit_without_flags_exits_2(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        code, _, _ = self.run_cli("edit", "my-a")
        self.assertEqual(code, 2)
        self.assertEqual(self.daemon.calls("PATCH", ""), [])

    def test_edit_patches_name_category_and_replaces_tags(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        code, _, _ = self.run_cli("edit", "my-a", "--name", "Beta", "--category", "hooks", "--tag", "one", "--tag", "two")
        self.assertEqual(code, 0)
        self.assertEqual(
            self.daemon.calls("PATCH", "/api/bank/user/elements/my-a"),
            [{"name": {"ru": "Beta", "en": "Beta"}, "category": "hooks", "tags": {"ru": ["one", "two"], "en": ["one", "two"]}}],
        )

    def test_edit_one_language_name_keeps_the_other(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        self.run_cli("edit", "my-a", "--name-ru", "Альфа")
        self.assertEqual(self.daemon.calls("PATCH", "")[0], {"name": {"ru": "Альфа", "en": "Alpha"}})

    def test_edit_add_tag_extends_the_current_tags(self) -> None:
        self.daemon.seed("my-a", "Alpha", tags={"ru": ["а"], "en": ["a"]})
        self.run_cli("edit", "my-a", "--add-tag", "b", "--add-tag", "a")
        self.assertEqual(self.daemon.calls("PATCH", "")[0], {"tags": {"ru": ["а", "b", "a"], "en": ["a", "b"]}})

    def test_edit_json_prints_the_element(self) -> None:
        self.daemon.seed("my-a", "Alpha")
        _, out, _ = self.run_cli("edit", "my-a", "--category", "hooks", "--json")
        self.assertEqual(json.loads(out)["element"]["category"], "hooks")

    # ---- transport ---------------------------------------------------------------------------

    def test_daemon_down_exits_3(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            free_port = probe.getsockname()[1]
        code, _, err = self.run_cli("list", port=free_port)
        self.assertEqual(code, 3)
        self.assertIn("hsw-editor start", err)


if __name__ == "__main__":
    unittest.main()
