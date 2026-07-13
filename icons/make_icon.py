"""Generate the extension icon: NYU-violet bubble with a white capital A.

No Pillow/ImageMagick here, so: rasterize at high resolution with a supersample
grid (giving antialiasing on both the circle's edge and the letter), then box-
downsample to each target size and hand-encode an RGBA PNG.
"""
import zlib, struct, math, os

PURPLE = (0x57, 0x06, 0x8C)   # NYU violet, same as the popup's primary button
WHITE  = (0xFF, 0xFF, 0xFF)
OUT    = "/home/charl/code/remote/albert_extension/icons"

# --- letter geometry, in unit coords (0..1 across the icon) ------------------
#
# OPTICAL CENTRING: an "A" is a triangle — wide at the base, narrow at the apex —
# and the crossbar sits below the midline, so its visual mass pools low. Centring
# the bounding box (which is what the first cut did) therefore READS low: the ink
# centroid measured 0.537 against a circle centre of 0.500. But shifting all the
# way up to centroid-centre overshoots and crowds the apex against the rim. Half
# the offset is the balance point — checked by rendering all three side by side.
LIFT   = 0.0186         # half the measured centroid offset
APEX   = (0.500, 0.245 - LIFT)
LFOOT  = (0.288, 0.762 - LIFT)
RFOOT  = (0.712, 0.762 - LIFT)
BAR_Y  = 0.605 - LIFT
STROKE = 0.112          # limb thickness
BAR_T  = 0.094          # crossbar thickness
R      = 0.492          # bubble radius


def dist_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx, dy = wx - t * vx, wy - t * vy
    return math.hypot(dx, dy)


def lerp_x_at_y(p, q, y):
    """x of the line p->q at height y."""
    t = (y - p[1]) / (q[1] - p[1])
    return p[0] + t * (q[0] - p[0])


BAR_L = (lerp_x_at_y(APEX, LFOOT, BAR_Y), BAR_Y)
BAR_R = (lerp_x_at_y(APEX, RFOOT, BAR_Y), BAR_Y)


def sample(x, y):
    """Return (in_circle, in_letter) for a unit-square point."""
    in_circle = math.hypot(x - 0.5, y - 0.5) <= R
    d = min(
        dist_seg(x, y, *LFOOT, *APEX),
        dist_seg(x, y, *RFOOT, *APEX),
    )
    in_letter = d <= STROKE / 2
    if not in_letter:
        in_letter = dist_seg(x, y, *BAR_L, *BAR_R) <= BAR_T / 2
    return in_circle, in_letter


def render(size, ss=6):
    """Supersample ss*ss per pixel, then average -> antialiased RGBA bytes."""
    px = bytearray()
    inv = 1.0 / (size * ss)
    n = ss * ss
    for py in range(size):
        for pxi in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    ux = (pxi * ss + sx + 0.5) * inv
                    uy = (py * ss + sy + 0.5) * inv
                    ic, il = sample(ux, uy)
                    if not ic:
                        continue          # transparent outside the bubble
                    col = WHITE if il else PURPLE
                    r += col[0]; g += col[1]; b += col[2]; a += 255
            if a == 0:
                px += bytes((0, 0, 0, 0))
            else:
                # colour averaged over covered samples only, alpha over all
                cov = a / 255.0
                px += bytes((
                    round(r / cov), round(g / cov), round(b / cov), round(a / n),
                ))
    return bytes(px)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    ss = 8 if s <= 48 else 4          # keep the 128 render affordable
    write_png(f"{OUT}/icon{s}.png", s, render(s, ss))
    print(f"icon{s}.png  {os.path.getsize(f'{OUT}/icon{s}.png')} bytes")
