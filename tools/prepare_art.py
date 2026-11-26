"""Prepare one coat from a directory of transparent PNGs (see docs/DEVELOPMENT.md)."""
import argparse
import base64
import io
import json
import tempfile
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageOps

from portrait_scene import avatar_styles, dog_avatar, portrait_data, species_scene

PROTOTYPE = Path(__file__).resolve().parents[1] / "prototype"
COW = {
    "head": "head.png", "ear": "ear-left.png", "body": "body.png",
    "arm-l": "arm-black.png", "arm-r": "arm-white.png",
    "paw-l": "paw-black.png", "paw-r": "paw-white.png",
    **{name: f"v2/{name}.png" for name in ("tail", "back-head", "ear-back", "back-body")},
}
# Cat coordinates below mirror coats.js. The dog gets its SPEC placement from the species registry.
PORTRAITS = {
    "cow": {}, "lihua": {}, "black": {}, "white": {},
    "calico": {"head": (400, 173.1, 266)},
    "orange": {"headSX": 1.08},
    "blue": {"head": (399.6, 179.6, 291.3), "ear": (276.3, 62.3, 75.5, 0)},
    "siamese": {"head": (400.1, 168.9, 241.3), "ear": (272, 22, 110, 12)},
    "maine": {"head": (400.4, 178.1, 322.3), "ear": (278, 14, 110, 0), "ear_scale": 1.15},
    "sphynx": {"head": (400.1, 169.1, 255.3), "ear": (268, 34, 110, 16), "ear_scale": 1.18},
    "tianyuan": {"species": "dog"},
}


def publish(path, data):
    # The preview server may read these files while an artist regenerates them.
    tmp = tempfile.NamedTemporaryFile(dir=path.parent, delete=False)
    temporary = Path(tmp.name)
    try:
        with tmp:
            tmp.write(data)
        temporary.chmod(0o644)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(source):
    with Image.open(source) as raw:
        image = raw.convert("RGBA")
    alpha = image.getchannel("A").point(lambda a: a if a >= 32 else 0)
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError(f"No opaque pixels: {source}")
    image.putalpha(alpha)
    image = ImageOps.expand(image.crop(bbox), border=6, fill=(0, 0, 0, 0))
    image.thumbnail((768, 768), Image.Resampling.LANCZOS)
    return image


def portrait_image(directory, key, width, x, y=None, cy=176):
    with Image.open(directory / f"{key}.webp") as image:
        height = width * image.height / image.width
        image.thumbnail((256, 256), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=85, method=6)
    return ET.Element("image", {
        "href": "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode(),
        "width": str(width), "height": f"{height:.3f}", "x": str(x),
        "y": str(y) if y is not None else f"{cy - height / 2:.3f}",
    })


def cat_avatar(cat, sizes):
    # Reuse the scene's vector face and palette, including side-specific lids and irises.
    scene = species_scene(PROTOTYPE, "parts-cat")
    head = scene.find(".//*[@id='cat-head']")
    root = ET.Element("svg", {"xmlns": "http://www.w3.org/2000/svg",
                              "viewBox": "244 12 312 284", "data-cat": cat})
    ET.SubElement(root, "style").text = avatar_styles(PROTOTYPE)
    defs = ET.SubElement(root, "defs")
    for side in ("l", "r"):
        defs.append(scene.find(f".//*[@id='clip-eye-{side}']"))
    config = PORTRAITS[cat]
    cx, cy, width = config.get("head", (400, 176, 300))
    x, y, ear_width, angle = config.get("ear", (278, 24, 110, 0))
    head_scale, ear_scale = config.get("headSX", 1), config.get("ear_scale", 1)
    pose = ET.SubElement(root, "g", {"id": "scene", "transform":
        f"rotate(-4 400 262) translate(400 262) scale({head_scale} 1) translate(-400 -262)"})
    directory = PROTOTYPE / "art" / cat
    for side, pivot in (("l", 322), ("r", 478)):
        ear = ET.SubElement(pose, "g", {"transform":
            f"translate({pivot} 110) scale({ear_scale}) translate({-pivot} -110)"})
        key = "ear-r" if side == "r" and "ear-r" in sizes else "ear"
        if key not in sizes:
            ear.append(head.find(f"./g[@id='ear-{side}']"))
        elif side == "r" and key == "ear":
            ET.SubElement(ear, "use", {"href": "#portrait-ear",
                                        "transform": "translate(800 0) scale(-1 1)"})
        else:
            right = key == "ear-r"
            image = portrait_image(directory, key, ear_width, 800 - x - ear_width if right else x, y)
            if not right:
                image.set("id", "portrait-ear")
            if angle:
                w, h = sizes[key]
                px, py = config.get("pivot", (x + ear_width / 2, y + ear_width * h / w))
                image.set("transform", f"rotate({angle if right else -angle} {800 - px if right else px} {py})")
            ear.append(image)
    if "head" in sizes:
        pose.append(portrait_image(directory, "head", width, cx - width / 2, cy=cy))
    else:
        for key in ("head-fill", "head-line"):
            pose.append(head.find(f"./path[@id='{key}']"))
    # Keep the original paint order when extracting the cat's grouped face.
    for layer in head:
        if layer.get("data-species-face") == "cat":
            pose.extend(layer)
            continue
        child = layer
        if child.get("class") in ("blush", "whisker", "fang", "ink-thin coat-mouth-line",
                                  "ink-thin coat-nose", "coat-cow-marking"):
            pose.append(child)
        elif child.get("id") in ("eye-l-open", "eye-r-open"):
            if cat == "lihua":
                cx = child.find("circle").get("cx")
                child.insert(0, ET.Element("circle", {"class": "coat-rim", "cx": cx,
                                                      "cy": "178", "r": "34"}))
            pose.append(child)
    return root


def fur_dog_avatar(coat, sizes):
    portrait = next(portrait for portrait in portrait_data(PROTOTYPE) if portrait["id"] == coat)
    directory = PROTOTYPE / "art" / coat
    head = portrait["art"]["head"]
    ear = portrait["art"]["ear"]
    mirror = 2 * portrait["rig"]["turnX"]
    head_image = portrait_image(directory, "head", head["width"], head["cx"] - head["width"] / 2, cy=head["cy"])
    left_ear = portrait_image(directory, "ear", ear["width"], ear["x"], ear["y"])
    left_ear.set("id", "portrait-ear")
    right_ear = ET.Element("use", {"href": "#portrait-ear", "transform": f"translate({mirror} 0) scale(-1 1)"})
    if "ear-r" in sizes:
        right_ear = portrait_image(directory, "ear-r", ear["width"], mirror - ear["x"] - ear["width"], ear["y"])
    angle = ear.get("rotate", 0)
    if angle:
        for image, key in ((left_ear, "ear"), (right_ear, "ear-r")):
            if key not in sizes:
                continue
            w, h = sizes[key]
            pivot = ear.get("pivot", {"x": ear["x"] + ear["width"] / 2, "y": ear["y"] + ear["width"] * h / w})
            x, y = pivot["x"], pivot["y"]
            transform = f"rotate({-angle} {x} {y})" if key == "ear" else f"rotate({angle} {mirror - x} {y})"
            image.set("transform", transform)
    return dog_avatar(PROTOTYPE, portrait, (left_ear, right_ear), head_image)


def avatar(coat, sizes):
    root = fur_dog_avatar(coat, sizes) if PORTRAITS[coat].get("species") == "dog" else cat_avatar(coat, sizes)
    path = PROTOTYPE / "cats" / f"{coat}.svg"
    ET.indent(root)
    publish(path, ET.tostring(root, encoding="utf-8") + b"\n")
    print(f"{path.name}: {path.stat().st_size:,} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cat", default="cow", choices=PORTRAITS)
    parser.add_argument("--source", type=Path, required=True, help="原图目录（不进仓库，奶牛猫的原图另存在仓库外）")
    args = parser.parse_args()
    if not args.source.is_dir():
        parser.error(f"Missing source directory: {args.source}")
    mapping = COW if args.cat == "cow" else {name: f"{name}.png" for name in COW}
    for name in ("ear-r", "ear-back-r"):
        if (args.source / f"{name}.png").is_file():
            mapping = {**mapping, name: f"{name}.png"}
    output = PROTOTYPE / "art" / args.cat
    output.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for name, filename in mapping.items():
        source = args.source / filename
        if not source.is_file():
            print(f"{name}: missing ({filename}), using vector")
            continue
        image = prepare(source)
        path = output / f"{name}.webp"
        encoded = io.BytesIO()
        image.save(encoded, "WEBP", quality=90, method=6)
        publish(path, encoded.getvalue())
        sizes[name] = image.size
        print(f"{path.name}: {image.width}x{image.height}, {path.stat().st_size:,} bytes")
    manifest = output / "manifest.js"
    registration = f"SillyArt.register({json.dumps(args.cat)}, {json.dumps(sizes)});\n"
    publish(manifest, registration.encode("utf-8"))
    print(f"{manifest.name}: {manifest.stat().st_size:,} bytes")
    if {"head", "ear"} <= sizes.keys():
        avatar(args.cat, sizes)


if __name__ == "__main__":
    main()
