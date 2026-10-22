"""Contact sheet of bank thumbnails for visual review: contact_sheet.py <bank dir> <out.png> [id-substring ...]."""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

TILE = 192
COLUMNS = 6
BACKGROUND = (236, 238, 242)


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    needles = sys.argv[3:]
    index = json.loads((root / "index.json").read_text())
    elements = [e for e in index["elements"] if not needles or any(n in e["id"] for n in needles)]
    rows = (len(elements) + COLUMNS - 1) // COLUMNS
    sheet = Image.new("RGB", (COLUMNS * TILE, rows * (TILE + 16)), BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    for i, element in enumerate(elements):
        thumb = Image.open(root / element["assets"]["thumbnail"]["path"]).convert("RGBA")
        tile = Image.new("RGBA", thumb.size, (*BACKGROUND, 255))
        tile.alpha_composite(thumb)
        x, y = (i % COLUMNS) * TILE, (i // COLUMNS) * (TILE + 16)
        sheet.paste(tile.convert("RGB"), (x, y + 16))
        dims = element["dimsMm"]
        draw.text((x + 2, y + 2), f"{element['id'][:32]} {dims['x']:.0f}x{dims['y']:.0f}x{dims['z']:.0f}", fill=(0, 0, 0))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"{len(elements)} elements -> {out}")


if __name__ == "__main__":
    main()
