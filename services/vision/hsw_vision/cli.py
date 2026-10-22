"""`python -m hsw_vision`: the sidecar server and server-less runs of the same pipeline.

  serve                       run the HTTP sidecar (loopback 127.0.0.1:8795, or --socket PATH)
  photo-to-wall IMAGE --out DIR   photo -> wall proposal, no server (evidence runs, `hsw-editor vision photo-to-wall`)
  photo-to-objects IMAGE --out DIR   photo -> per-object masks, crops, classes, fitted models, colours (objects.json)
  embed IMAGE... --out DIR       CLIP embeddings (512 floats, L2-normalised) of whole images or their single object
  models status|fetch [NAME...]   what is on disk / explicit download (the only place that downloads)
  doctor                      models present/missing, GPU free VRAM, ORT CUDA state, heavy imports

Exit codes: 0 ok, 1 failure, 2 bad input or no scale (`needs_calibration`), 3 low confidence, 127 missing model/dependency.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from hsw_vision.config import FETCH_MODELS_HINT, SETUP_HINT, VisionConfig
from hsw_vision.errors import EXIT_BAD_INPUT, EXIT_FAILED, BadRequest, VisionServiceError, translate_library_error


def parse_two_point(text: str) -> tuple[float, float, float, float]:
    try:
        x1, y1, x2, y2 = (float(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("expected X1,Y1,X2,Y2 (four numbers, photo pixels)") from None
    return x1, y1, x2, y2


BANK_INDEX_CANDIDATES = (
    Path.home() / ".local/share/hsw-editor/bank/index.json",
    Path(__file__).resolve().parents[3] / "packages/bank/seed/index.json",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hsw-vision", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = parser.add_subparsers(dest="cmd", required=True)

    serve = subs.add_parser("serve", help="run the HTTP sidecar")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--socket", help="serve on a unix socket instead of loopback TCP")

    p2w = subs.add_parser("photo-to-wall", help="photo -> wall proposal without the server")
    add_photo_options(p2w, out_help="output + result-cache directory")
    p2w.add_argument("--photo-id", help="id of the photo on a wall (recorded in item sources)")
    p2w.add_argument("--auto-apply", type=float, metavar="CONF", help="flag items >= CONF as autoApply (default: never)")

    p2o = subs.add_parser("photo-to-objects", help="photo -> per-object masks, crops, classes, fitted models, colours")
    add_photo_options(p2o, out_help="result directory (objects.json, masks/, crops/, cutouts/, models/, overlays) and stage cache")
    p2o.add_argument("--topk", type=int, default=5, help="class candidates per object")
    p2o.add_argument("--no-colours", action="store_true", help="skip per-part colour sampling")
    p2o.add_argument("--extra-photo", action="append", type=Path, default=[], help="another viewpoint of the same objects (repeatable)")

    embed = subs.add_parser("embed", help="CLIP image embeddings (embeddings.npy + embeddings.json)")
    embed.add_argument("images", nargs="+", type=Path)
    embed.add_argument("--out", type=Path, required=True, help="writes embeddings.npy (N x 512 float32) and embeddings.json")
    embed.add_argument("--object", action="store_true", help="embed the masked single object (u2net) instead of the whole image")
    embed.add_argument("--device", choices=("auto", "cpu", "cuda"), default=None)
    embed.add_argument("--json", action="store_true", help="print embeddings.json on stdout")

    models = subs.add_parser("models", help="model files")
    msub = models.add_subparsers(dest="models_cmd", required=True)
    msub.add_parser("status")
    fetch = msub.add_parser("fetch", help="explicit download (never happens at request time)")
    fetch.add_argument("names", nargs="*")

    doctor = subs.add_parser("doctor", help="models, GPU, ORT CUDA state")
    doctor.add_argument("--json", action="store_true")
    return parser


def add_photo_options(parser: argparse.ArgumentParser, *, out_help: str) -> None:
    """The options `photo-to-wall` and `photo-to-objects` share."""
    parser.add_argument("image", type=Path)
    parser.add_argument("--out", type=Path, required=True, help=out_help)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default=None)
    parser.add_argument("--bank-index", default="auto", help="bank index.json for classes + holder hints ('none' to skip)")
    parser.add_argument("--two-point", type=parse_two_point, metavar="X1,Y1,X2,Y2", help="manual scale: two picked photo pixels ...")
    parser.add_argument("--distance", type=float, metavar="MM", help="... and their real distance in mm")
    parser.add_argument("--mm-per-px", type=float, help="manual scale")
    parser.add_argument("--method", choices=("sam2", "sam2-dense", "u2net"), default="sam2")
    parser.add_argument("--fill", choices=("owlv2", "none"), default="owlv2")
    parser.add_argument("--categories", help="classes to recognise: a file or comma list (threed_vision.recognise.load_categories)")
    parser.add_argument("--max-objects", type=int, default=60)
    parser.add_argument("--ai-assist", action="store_true", help="ask omp about low-confidence items (needs HSW_VISION_AI_ASSIST=1)")
    parser.add_argument("--refresh", action="store_true", help="ignore cached stage results")
    parser.add_argument("--json", action="store_true", help="print the full result JSON on stdout")


def calibration_params(args: argparse.Namespace) -> Any:
    from hsw_vision.schemas import CalibrateParams

    calibrate: dict[str, Any] = {}
    if args.two_point:
        if args.distance is None:
            raise BadRequest("--two-point needs --distance MM (the real distance between the two points)")
        x1, y1, x2, y2 = args.two_point
        calibrate.update(points_px=((x1, y1), (x2, y2)), distance_mm=args.distance)
    if args.mm_per_px:
        calibrate["mm_per_px"] = args.mm_per_px
    return CalibrateParams(**calibrate)


def load_bank_index(spec: str) -> dict[str, Any] | None:
    if spec == "none":
        return None
    candidates = [Path(spec)] if spec != "auto" else list(BANK_INDEX_CANDIDATES)
    for path in candidates:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]
    if spec != "auto":
        raise SystemExit(f"hsw-vision: bank index not found: {spec}")
    return None


def progress_printer(event: dict[str, Any]) -> None:
    """One stderr line per finished stage / object, and the events a human has to act on."""
    if event.get("event") == "stage" and event.get("state") == "done":
        print(f"[{event['stage']}] {event.get('seconds', '')}s", file=sys.stderr, flush=True)
    elif event.get("event") == "object":
        print(f"  object {event['instanceId']} {event['state']} ({event['done']}/{event['total']})", file=sys.stderr, flush=True)
    elif event.get("type") == "request_view" or event.get("event") == "needs_calibration":
        print(f"[{event.get('type') or event['event']}] {json.dumps(event)[:300]}", file=sys.stderr, flush=True)


def write_artefacts(out: Path, result: dict[str, Any], started: float, *, proposal: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)

    def write(name: str, value: Any) -> None:
        (out / name).write_text(json.dumps(value, indent=2, default=str) + "\n", encoding="utf-8")

    write("result.json", result)
    write("timings.json", {**result["diagnostics"]["timing_s"], "wall_clock": round(time.monotonic() - started, 3)})
    if proposal and result.get("proposal"):
        write("proposal.json", result["proposal"])


def cmd_photo_to_wall(args: argparse.Namespace, config: VisionConfig) -> int:
    from hsw_vision import photo_to_wall
    from hsw_vision.schemas import PhotoToWallRequest, SegmentParams
    from hsw_vision.service import VisionService

    request = PhotoToWallRequest(
        image_path=args.image,
        work_dir=args.out,
        photo_id=args.photo_id,
        calibrate=calibration_params(args),
        segment=SegmentParams(method=args.method, fill=args.fill),
        bank_index=load_bank_index(args.bank_index),
        categories=args.categories,
        auto_apply_confidence=args.auto_apply,
        max_objects=args.max_objects,
        device=args.device,
        ai_assist=args.ai_assist,
        refresh=args.refresh,
    )
    if args.device:
        config = dataclasses.replace(config, device=args.device)
    service = VisionService.create(config)
    started = time.monotonic()
    result = photo_to_wall.run(service, request, progress_printer)
    write_artefacts(args.out, result, started, proposal=True)
    overlay = (result.get("segmentation") or {}).get("overlay")
    if overlay:
        shutil.copyfile(Path(result["work"]["imageDir"]) / overlay, args.out / "overlay.jpg")
    if args.json:
        print(json.dumps(result, default=str))
    else:
        print(summary(result, args.out))
    return EXIT_BAD_INPUT if result["status"] == "needs_calibration" else 0


def cmd_photo_to_objects(args: argparse.Namespace, config: VisionConfig) -> int:
    from hsw_vision import objects
    from hsw_vision.schemas import PhotoToObjectsRequest, SegmentParams
    from hsw_vision.service import VisionService

    request = PhotoToObjectsRequest(
        image_path=args.image,
        work_dir=args.out / "cache",
        out_dir=args.out,
        calibrate=calibration_params(args),
        segment=SegmentParams(method=args.method, fill=args.fill),
        bank_index=load_bank_index(args.bank_index),
        categories=args.categories,
        max_objects=args.max_objects,
        device=args.device,
        ai_assist=args.ai_assist,
        refresh=args.refresh,
        topk=args.topk,
        colours=not args.no_colours,
        extra_photos=args.extra_photo,
    )
    if args.device:
        config = dataclasses.replace(config, device=args.device)
    service = VisionService.create(config)
    started = time.monotonic()
    result = objects.run(service, request, progress_printer)
    write_artefacts(args.out, result, started, proposal=False)
    if args.json:
        print(json.dumps(result, default=str))
    else:
        print(objects_summary(result, args.out))
    return EXIT_BAD_INPUT if result["status"] == "no_scale" else 0


def cmd_embed(args: argparse.Namespace, config: VisionConfig) -> int:
    """One CLIP embedding per image, rows in argument order. `--object` embeds the largest single object of each image
    (u2net mask, the way `photo-to-objects` embeds its crops) so a thumbnail of one tool compares with a photo crop."""
    import numpy as np

    from hsw_vision.cache import file_sha256
    from hsw_vision.files import save_npy, write_json
    from hsw_vision.schemas import ImageRef, SegmentParams
    from hsw_vision.service import VisionService
    from hsw_vision.stages import embed as stage_embed

    if args.device:
        config = dataclasses.replace(config, device=args.device)
    service = VisionService.create(config)
    args.out.mkdir(parents=True, exist_ok=True)
    photos = [service.read_photo(path) for path in args.images]
    items: list[dict[str, Any]] = []
    masks = []
    if args.object:
        for path, _ in photos:  # `segment` takes the run lock itself: never hold it here (it is not re-entrant)
            img = service.open(ImageRef(image_path=path, work_dir=args.out / "cache"))
            seg = service.segment(img, SegmentParams(method="u2net"))
            if not seg["instances"]:
                raise BadRequest(f"no object found in {path}")
            largest = max(seg["instances"], key=lambda i: i["area_px"])
            masks.append(service.masks(img, seg, only=[largest["id"]])[largest["id"]])
    with service.run_lock:
        if args.object:
            rows = np.concatenate([service.stages.embed_objects(service.manager, rgb, [mask]) for (_, rgb), mask in zip(photos, masks, strict=True)])
        else:
            rows = service.stages.embed_images(service.manager, [rgb for _, rgb in photos])
    for row, (path, rgb) in enumerate(photos):
        items.append({"image": str(path), "sha256": file_sha256(path), "row": row, "object": bool(args.object), "size": [rgb.shape[1], rgb.shape[0]]})
    save_npy(args.out / "embeddings.npy", rows)
    report = {"model": stage_embed.MODEL, "dim": stage_embed.DIM, "file": "embeddings.npy", "items": items}
    write_json(args.out / "embeddings.json", report)
    print(json.dumps(report) if args.json else f"{len(items)} embedding(s) -> {args.out}/embeddings.npy (+ embeddings.json)")
    return 0


def objects_summary(result: dict[str, Any], out: Path) -> str:
    s = result["summary"]
    cal = result["calibration"]
    scale = f"{cal['method']} {cal['mm_per_px']:.4f} mm/px" if cal.get("ok") else "NO SCALE (pass --two-point/--distance or --mm-per-px for dimensions)"
    return "\n".join(
        [
            f"calibration: {scale}",
            f"objects found {s['found']}, analysed {s['analysed']} (recognised {s['recognised']}, fitted {s['fitted']}, "
            f"failed {s['failed']}, want another view {s['needsViews']}, needs confirmation {s['needsConfirmation']})",
            f"timing_s {json.dumps(result['diagnostics']['timing_s'])}",
            f"artefacts: {out}/objects.json masks/ crops/ cutouts/ models/ overlay.jpg fit-overlay.jpg",
        ]
    )


def summary(result: dict[str, Any], out: Path) -> str:
    if result["status"] == "needs_calibration":
        return f"needs calibration: {result.get('message')}\n(pass --two-point X1,Y1,X2,Y2 --distance MM or --mm-per-px)"
    s = result["proposal"]["summary"]
    cal = result["calibration"]
    lines = [
        f"calibration: {cal['method']} {cal['mm_per_px']:.4f} mm/px",
        f"objects {s['objects']} (recognised {s['recognised']}, needs confirmation {s['needsConfirmation']}, "
        f"want another view {s['needsViews']}, autoApply {s['autoApply']}), holder proposals {s['holders']}",
        f"timing_s {json.dumps(result['diagnostics']['timing_s'])}",
        f"artefacts: {out}/proposal.json result.json timings.json overlay.jpg",
    ]
    return "\n".join(lines)


def cmd_models(args: argparse.Namespace, config: VisionConfig) -> int:
    from threed_vision import models as tv_models

    config.apply_to_environment()
    if args.models_cmd == "status":
        print(json.dumps(tv_models.status(), indent=2, default=str))
        return 0
    names = args.names or None

    last_decile: dict[str, int] = {}

    def progress(model: str, file: str, done: int, total: int | None) -> None:
        """One line per file per 10 % (or per 64 MiB when the size is unknown)."""
        key = f"{model}/{file}"
        step = done * 10 // total if total else done >> 26
        if last_decile.get(key) != step:
            last_decile[key] = step
            print(f"{key}: {done}/{total or '?'} bytes", file=sys.stderr, flush=True)

    result = tv_models.fetch(names, progress=progress)
    print(file=sys.stderr)
    print(json.dumps(result, indent=2, default=str))
    return 0


def doctor_report(config: VisionConfig) -> dict[str, Any]:
    """Facts for `hsw-editor vision doctor`: each check is `{ok|warn|fail, detail, fix?}`."""
    config.apply_to_environment()
    checks: dict[str, dict[str, Any]] = {}
    try:
        from threed_vision import device as tv_device
        from threed_vision import models as tv_models

        status = tv_models.status()
        models = status.get("models", {})
        missing = sorted(name for name, info in models.items() if not info.get("installed"))
        checks["models"] = {
            "level": "ok" if not missing else "warn",
            "detail": f"{len(models) - len(missing)}/{len(models)} present in {status.get('models_dir')}",
            "missing": missing,
            **({"fix": FETCH_MODELS_HINT} if missing else {}),
        }
        free = tv_device.free_vram_mb()
        checks["gpu"] = {
            "level": "ok" if free is not None else "warn",
            "detail": f"{free} MB free VRAM" if free is not None else "no usable CUDA device: CPU mode",
            "freeVramMb": free,
        }
        ort = tv_device.ort_diagnose()
        usable = bool(ort.get("cuda_usable"))
        checks["onnxruntime"] = {
            "level": "ok" if usable or free is None else "warn",
            "detail": json.dumps(ort, default=str),
            **({} if usable or free is None else {"fix": "pin onnxruntime-gpu==1.23.2 and install the cu128 torch (docs/vision.md)"}),
        }
    except Exception as exc:  # noqa: BLE001
        translated = translate_library_error(exc)
        checks["library"] = {"level": "fail", "detail": f"{type(exc).__name__}: {exc}", "fix": (translated.fix if translated else None) or SETUP_HINT}
    for module in ("torch", "sam2", "transformers", "onnxruntime", "cma", "trimesh"):
        try:
            __import__(module)
            checks[f"import:{module}"] = {"level": "ok", "detail": "importable"}
        except ImportError:
            checks[f"import:{module}"] = {"level": "warn", "detail": "not installed", "fix": SETUP_HINT}
    return {"ok": all(c["level"] != "fail" for c in checks.values()), "modelsDir": str(config.models_dir), "checks": checks}


def cmd_doctor(args: argparse.Namespace, config: VisionConfig) -> int:
    report = doctor_report(config)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for name, check in report["checks"].items():
            print(f"{check['level']:<4} {name}: {check['detail']}")
            if check.get("fix") and check["level"] != "ok":
                print(f"     fix: {check['fix']}")
    return 0 if report["ok"] else EXIT_FAILED


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = VisionConfig.from_env()
    except ValueError as exc:  # e.g. HSW_VISION_PORT=8O95
        print(f"hsw-vision: invalid HSW_VISION_* environment: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    try:
        if args.cmd == "serve":
            from hsw_vision.serve import serve

            overrides: dict[str, Any] = {}
            if args.host:
                if args.host not in ("127.0.0.1", "localhost"):
                    raise BadRequest(
                        "the sidecar reads and writes arbitrary local paths and its port picker is IPv4-only: "
                        "bind 127.0.0.1 or localhost"
                    )
                overrides["host"] = args.host
            if args.port:
                overrides["port"] = args.port
            if args.socket:
                overrides["socket_path"] = Path(args.socket)
            serve(dataclasses.replace(config, **overrides))
            return 0
        if args.cmd == "photo-to-wall":
            return cmd_photo_to_wall(args, config)
        if args.cmd == "photo-to-objects":
            return cmd_photo_to_objects(args, config)
        if args.cmd == "embed":
            return cmd_embed(args, config)
        if args.cmd == "models":
            return cmd_models(args, config)
        return cmd_doctor(args, config)
    except VisionServiceError as exc:
        print(json.dumps(exc.to_json()), file=sys.stderr)
        print(f"hsw-vision: {exc.message}" + (f"\n  fix: {exc.fix}" if exc.fix else ""), file=sys.stderr)
        return exc.exit_code
    except Exception as exc:
        translated = translate_library_error(exc)
        if translated is None:
            raise
        print(f"hsw-vision: {translated.message}\n  fix: {translated.fix}", file=sys.stderr)
        return translated.exit_code
