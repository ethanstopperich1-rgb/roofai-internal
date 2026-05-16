"""
Draw a red crosshair at the pin location on a satellite tile.

Usage:
  python annotate-tile-with-pin.py <in.png> <out.png> <pin_x> <pin_y>

Crosshair specs (per Phase 1 experiment):
  - Outer ring: radius 20 px, red (#FF0000), stroke 3 px, 50% opacity
  - Inner dot:  radius 3 px, red (#FF0000), 100% opacity

Subtle enough not to interfere with roof tracing, prominent enough
that Gemini's vision encoder picks it up as a salient feature.
"""
import sys
from PIL import Image, ImageDraw

if len(sys.argv) != 5:
    sys.exit("usage: annotate-tile-with-pin.py <in.png> <out.png> <pin_x> <pin_y>")

in_path, out_path, px, py = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

img = Image.open(in_path).convert("RGBA")
overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)

# Outer ring: r=20px, 3px stroke, 50% opacity red.
RING_R, RING_STROKE = 20, 3
draw.ellipse(
    [px - RING_R, py - RING_R, px + RING_R, py + RING_R],
    outline=(255, 0, 0, 128),
    width=RING_STROKE,
)

# Inner dot: r=3px, solid red.
DOT_R = 3
draw.ellipse(
    [px - DOT_R, py - DOT_R, px + DOT_R, py + DOT_R],
    fill=(255, 0, 0, 255),
)

out = Image.alpha_composite(img, overlay).convert("RGB")
out.save(out_path, "PNG")
print(f"annotated -> {out_path}  pin=({px},{py})")
