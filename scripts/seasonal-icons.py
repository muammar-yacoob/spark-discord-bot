"""Set each Discord server's icon to its app mark wearing the current season's hat.

Run with no args to apply the season for today; pass --season <name> to force one,
and --dry-run to write the PNGs to /tmp without touching Discord.

The marks are abstract logos with no "head", so a hat centred on top reads as a
sticker. The mark is shrunk into the lower-right and the hat perched over its
top-left shoulder, which reads as decoration rather than defacement.
"""

import argparse
import math
import base64
import json
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
PROJECTS = Path("/home/spark/projects")
S = 512

# Hat width as a fraction of the mark's width, and how far its base sinks into
# the mark (fraction of hat height). Tuned so the hat reads as worn, not perched.
HAT_SCALE = 0.95
HAT_SINK = 0.42

# config filename (without .json) -> local base icon
ICONS = {
    "bottled": PROJECTS / "Bottled/public/favicon.png",
    "sellular": PROJECTS / "Sellular/public/favicon.png",
    "viralcat": PROJECTS / "ViralCat/public/favicon.png",
    "spark-ai": PROJECTS / "spark-ai/public/favicon.png",
    "sparkpay": PROJECTS / "spark-pay/public/favicon.png",
    "spark-stack": PROJECTS / "spark-stack/app/favicon.png",
    "vidlet": PROJECTS / "vidlet-web/public/favicon.png",
    "quickpeek": PROJECTS / "QuickPeek/web/public/favicon.png",
}

# month -> style. Months absent from this map get the bare mark, no hat.
SEASONS = {
    3: "bunny", 4: "bunny",              # Easter
    5: "sun", 6: "sun", 7: "sun", 8: "sun",  # summer
    10: "witch",                          # Halloween
    11: "elf",                            # November
    12: "santa",                          # Christmas
}


def _blank():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def _rot(layer, deg, center):
    return layer.rotate(deg, center=center, resample=Image.BICUBIC)


def sun_hat():
    layer = _blank()
    d = ImageDraw.Draw(layer)
    straw, shade, ribbon = (232, 197, 116, 255), (206, 168, 88, 255), (238, 244, 250, 255)
    d.ellipse([28, 150, 372, 268], fill=straw)
    d.ellipse([60, 168, 340, 250], fill=shade)
    d.ellipse([28, 150, 372, 240], fill=straw)
    d.chord([116, 74, 284, 232], 180, 360, fill=straw)
    d.rounded_rectangle([116, 176, 284, 208], radius=14, fill=ribbon)
    return layer


def santa_hat():
    layer = _blank()
    d = ImageDraw.Draw(layer)
    red, white = (198, 40, 40, 255), (250, 250, 250, 255)
    d.polygon([(70, 190), (250, 60), (330, 140), (270, 172), (110, 200)], fill=red)
    d.rounded_rectangle([50, 172, 300, 228], radius=27, fill=white)
    d.ellipse([305, 108, 380, 183], fill=white)
    # Tail sweeps outward, away from the mark, instead of lying across it.
    return layer.transpose(Image.FLIP_LEFT_RIGHT)


def bunny_ears():
    layer = _blank()
    white, pink = (252, 252, 252, 255), (240, 150, 175, 255)
    for dx, tilt in ((-46, 13), (46, -6)):
        cx = 190 + dx
        ear = _blank()
        de = ImageDraw.Draw(ear)
        de.ellipse([cx - 40, 34, cx + 40, 228], fill=white)
        de.ellipse([cx - 21, 68, cx + 21, 200], fill=pink)
        layer.alpha_composite(_rot(ear, tilt, (cx, 228)))
    return layer


def elf_hat():
    layer = _blank()
    d = ImageDraw.Draw(layer)
    green, gold = (32, 132, 72, 255), (226, 182, 66, 255)
    d.polygon([(78, 196), (196, 48), (314, 196)], fill=green)
    d.rounded_rectangle([62, 184, 330, 230], radius=23, fill=gold)
    d.ellipse([172, 24, 220, 72], fill=gold)
    return layer


def witch_hat():
    layer = _blank()
    d = ImageDraw.Draw(layer)
    purple, orange = (58, 38, 82, 255), (232, 130, 38, 255)
    d.polygon([(104, 200), (200, 40), (296, 200)], fill=purple)
    d.ellipse([28, 180, 372, 244], fill=purple)
    d.rounded_rectangle([128, 158, 272, 198], radius=12, fill=orange)
    return layer


# Styles that never follow the mark's slope. Ears stand vertical on any head;
# tilting them just reads as broken.
UPRIGHT = {"bunny"}

# Drawing behind the mark was tried and dropped: it only works on a solid
# silhouette, and marks with gaps (QuickPeek) let the ears show through.
BEHIND = set()
BEHIND_SINK = 0.55

# Styles centred on the mark rather than on its highest pixel.
CENTRED = {"bunny"}

# Per-style size and sink overrides. Ears are tall and narrow, so the shared
# hat width made them tower over the mark.
STYLE_SCALE = {"bunny": 0.52}
STYLE_SINK = {"bunny": 0.14}

# Styles that always want a jaunty lean. A flat-topped mark (the paw, the
# layers) fits a slope of ~0, which leaves a sun hat sitting dead level and
# looking stiff, so these get a minimum tilt regardless of the silhouette.
ALWAYS_TILT = {"sun": 15.0}

# Per-app nudges, for marks the generic geometry gets wrong. "mark" and "hat"
# are size multipliers; "sink" overrides how deep the hat sits, so a higher
# value tucks more of the mark up under the brim.
APP_TUNING = {
    # The blob sits small in frame and wants its dome up under the brim.
    "sellular": {"mark": 1.20, "hat": 1.10, "sink": 0.66},
}

STYLES = {
    "sun": sun_hat,
    "santa": santa_hat,
    "bunny": bunny_ears,
    "elf": elf_hat,
    "witch": witch_hat,
}


def _skyline(mark, alpha_min=40):
    """Topmost opaque row per column: the mark's silhouette against the sky."""
    a = mark.split()[-1]
    w, h = mark.size
    px = a.load()
    line = {}
    for x in range(w):
        for y in range(h):
            if px[x, y] >= alpha_min:
                line[x] = y
                break
    return line


def _crown_and_tilt(mark, window=0.30, max_deg=14):
    """Find the mark's highest point, and the slope of the silhouette around it.

    Returns (crown_x, crown_y, angle_degrees). The angle is a least-squares fit of
    the skyline in a window either side of the crown, so a diagonal mark (Spark AI's
    galaxy) gets a hat tilted along its axis instead of sitting flat on a slope.
    """
    line = _skyline(mark)
    if not line:
        return mark.width // 2, 0, 0.0

    crown_x = min(line, key=lambda x: line[x])
    crown_y = line[crown_x]

    half = max(4, int(mark.width * window))
    pts = [(x, y) for x, y in line.items() if abs(x - crown_x) <= half]
    if len(pts) < 4:
        return crown_x, crown_y, 0.0

    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    num = sum((p[0] - mx) * (p[1] - my) for p in pts)
    den = sum((p[0] - mx) ** 2 for p in pts)
    if den == 0:
        return crown_x, crown_y, 0.0

    slope = num / den
    # Screen y grows downward, so a positive slope tips the hat clockwise; PIL's
    # rotate() is counter-clockwise-positive, hence the negation.
    angle = -math.degrees(math.atan(slope))
    angle = max(-max_deg, min(max_deg, angle))
    return crown_x, crown_y, angle


def compose(icon_path, style, app=None):
    """Mark anchored bottom-right at full weight, hat tucked into the top-left corner.

    The hat is cropped to its own bounding box and scaled down before placing, so it
    occupies the empty corner instead of lying across the mark. The icon stays the
    subject; the hat is an accessory in the negative space.
    """
    base = Image.open(icon_path).convert("RGBA").resize((S, S), Image.LANCZOS)
    canvas = _blank()
    if style is None:
        canvas.alpha_composite(base)
        return canvas

    # Crop to the mark's real pixels first. Every app icon carries a different
    # amount of transparent padding, so placing the hat by canvas coordinates puts
    # it across a wide mark (QuickPeek) while leaving a gap on a narrow one.
    tune = APP_TUNING.get(app, {})

    mbox = base.getbbox()
    mark = base.crop(mbox) if mbox else base

    # Reserve the top band for the hat; the mark fills the rest, bottom-aligned.
    avail_h = min(int(S * 0.70 * tune.get('mark', 1.0)), int(S * 0.92))
    avail_w = min(int(S * 0.86 * tune.get('mark', 1.0)), int(S * 0.94))
    scale = min(avail_w / mark.width, avail_h / mark.height)
    mark = mark.resize(
        (max(1, int(mark.width * scale)), max(1, int(mark.height * scale))),
        Image.LANCZOS,
    )
    mark_x = (S - mark.width) // 2
    mark_y = S - mark.height - int(S * 0.03)

    # Placement is derived from the mark itself: sit on its highest point, and lean
    # along the slope of its silhouette there.
    crown_x, crown_y, angle = _crown_and_tilt(mark)
    if style in UPRIGHT:
        angle = 0.0
    floor = ALWAYS_TILT.get(style)
    if floor is not None and abs(angle) < floor:
        # Keep the silhouette's direction when it has one, else lean left.
        angle = math.copysign(floor, angle) if angle else floor

    hat = STYLES[style]()
    hbox = hat.getbbox()
    if hbox:
        hat = hat.crop(hbox)
    target_w = int(
        mark.width * HAT_SCALE * STYLE_SCALE.get(style, 1.0) * tune.get('hat', 1.0)
    )
    hat = hat.resize(
        (target_w, max(1, int(hat.height * target_w / hat.width))), Image.LANCZOS
    )
    if angle:
        hat = hat.rotate(angle, resample=Image.BICUBIC, expand=True)

    if style in BEHIND:
        # Ears sprout from behind the head, so they centre on the mark itself rather
        # than on its highest pixel, and sink deep enough that the bases are hidden.
        hat_x = mark_x + (mark.width - hat.width) // 2
        hat_y = mark_y + crown_y - hat.height + int(hat.height * BEHIND_SINK)
        canvas.alpha_composite(hat, (max(0, hat_x), max(0, hat_y)))
        canvas.alpha_composite(mark, (mark_x, mark_y))
        return canvas

    # Worn on top: centre on the crown, then sink so the brim bites into the mark
    # and reads as worn rather than hovering.
    canvas.alpha_composite(mark, (mark_x, mark_y))
    if style in CENTRED:
        hat_x = mark_x + (mark.width - hat.width) // 2
    else:
        hat_x = mark_x + crown_x - hat.width // 2
    sink = tune.get('sink', STYLE_SINK.get(style, HAT_SINK))
    hat_y = mark_y + crown_y - hat.height + int(hat.height * sink)
    canvas.alpha_composite(hat, (max(0, hat_x), max(0, hat_y)))
    return canvas


def patch_guild_icon(guild_id, png_bytes, token):
    payload = json.dumps(
        {"icon": "data:image/png;base64," + base64.b64encode(png_bytes).decode()}
    ).encode()
    req = urllib.request.Request(
        f"https://discord.com/api/v10/guilds/{guild_id}",
        data=payload,
        method="PATCH",
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            # Discord rejects the default Python-urllib agent with a bare 403.
            "User-Agent": "DiscordBot (https://github.com/muammar-yacoob/spark-discord-bot, 1.0)",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return f"{e.code} {e.read().decode()[:180]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", choices=sorted(STYLES) + ["none"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="/tmp/seasonal-icons")
    args = ap.parse_args()

    if args.season:
        style = None if args.season == "none" else args.season
    else:
        style = SEASONS.get(date.today().month)

    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not token and not args.dry_run:
        sys.exit("DISCORD_BOT_TOKEN not set")

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    print(f"season style: {style or 'none (bare mark)'}")

    for cfg_path in sorted((REPO / "configs").glob("*.json")):
        name = cfg_path.stem
        icon = ICONS.get(name)
        if not icon or not icon.exists():
            print(f"  {name:<12} SKIP (no base icon at {icon})")
            continue
        cfg = json.loads(cfg_path.read_text())
        img = compose(icon, style, name)
        dest = outdir / f"{name}.png"
        img.save(dest)
        if args.dry_run:
            print(f"  {name:<12} wrote {dest}")
            continue
        status = patch_guild_icon(cfg["guild_id"], dest.read_bytes(), token)
        print(f"  {name:<12} {cfg['app']['name']} -> HTTP {status}")


if __name__ == "__main__":
    main()
