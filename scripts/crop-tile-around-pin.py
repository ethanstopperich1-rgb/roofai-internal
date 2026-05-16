"""
Crop a satellite tile to a square window centered on the pin.

Usage:
  python crop-tile-around-pin.py <in.png> <out.png> <pin_x> <pin_y> <crop_size>

Output is `crop_size × crop_size` px centered on (pin_x, pin_y) in the
input image. The pin lands at (crop_size/2, crop_size/2) in the output.

Used in Phase 2 of the visual-pin experiment: tighter context = less
surrounding territory for Gemini to wander to.
"""
import sys
from PIL import Image

if len(sys.argv) != 6:
    sys.exit("usage: crop-tile-around-pin.py <in.png> <out.png> <pin_x> <pin_y> <crop_size>")

in_path, out_path = sys.argv[1], sys.argv[2]
px, py, size = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])

img = Image.open(in_path)
W, H = img.size
half = size // 2
left = max(0, px - half)
top = max(0, py - half)
right = min(W, left + size)
bottom = min(H, top + size)
# Re-anchor if we hit the edge so output stays `size × size`.
if right - left < size:
    left = max(0, right - size)
if bottom - top < size:
    top = max(0, bottom - size)
right = left + size
bottom = top + size

cropped = img.crop((left, top, right, bottom))
cropped.save(out_path, "PNG")
new_pin_x = px - left
new_pin_y = py - top
print(f"cropped -> {out_path}  pin in crop=({new_pin_x},{new_pin_y})  crop bounds=({left},{top})-({right},{bottom})")
