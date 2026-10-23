# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10", "pillow-heif>=0.16"]
# ///
"""Photo intake normaliser: HEIC/HEIF/JPEG/PNG/WebP in, upright JPEG (or PNG when the input has alpha) out.

Every pixel coordinate of the wall overlay refers to the ORIENTED image, so the EXIF rotation is applied here once and
the tag is dropped. HEIC is converted because browsers cannot decode it. Offline after the first run (uv caches the
two wheels); nothing is fetched at runtime.

Usage: normalize_photo.py INPUT OUTPUT [--max-long-side N (0 = full size, the default)] [--quality 92]
Pixel coordinates of the overlay refer to the stored image, so the server never downsizes.
Prints one JSON line: {"mime", "width", "height", "orientation", "focal35mm", "converted"}.
Exit 2 for undecodable input (message on stderr).
"""
from __future__ import annotations

import argparse
import json
import sys

from PIL import Image, ImageOps, UnidentifiedImageError

EXIF_ORIENTATION = 0x0112
EXIF_IFD = 0x8769
EXIF_FOCAL_35MM = 0xA405


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--max-long-side", type=int, default=0, help="0 keeps the full size")
    parser.add_argument("--quality", type=int, default=92)
    args = parser.parse_args()

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:  # pragma: no cover - the dependency is declared above
        pass

    try:
        image = Image.open(args.input)
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as error:
        print(f"cannot decode image: {error}", file=sys.stderr)
        return 2

    exif = image.getexif()
    orientation = int(exif.get(EXIF_ORIENTATION, 1) or 1)
    focal = exif.get_ifd(EXIF_IFD).get(EXIF_FOCAL_35MM)
    source_format = (image.format or "").upper()
    icc = image.info.get("icc_profile")
    image = ImageOps.exif_transpose(image)

    if args.max_long_side > 0 and max(image.size) > args.max_long_side:
        image.thumbnail((args.max_long_side, args.max_long_side), Image.Resampling.LANCZOS)

    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    if has_alpha:
        image.convert("RGBA").save(args.output, "PNG", optimize=True, icc_profile=icc)
        mime = "image/png"
    else:
        image.convert("RGB").save(args.output, "JPEG", quality=args.quality, optimize=True, icc_profile=icc)
        mime = "image/jpeg"

    print(
        json.dumps(
            {
                "mime": mime,
                "width": image.size[0],
                "height": image.size[1],
                "orientation": orientation,
                "focal35mm": int(focal) if focal else None,
                "converted": source_format not in ("JPEG", "PNG") or orientation != 1,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
