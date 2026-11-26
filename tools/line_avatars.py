"""用场景部件生成猫的线条头像和待出图狗的临时头像。需要 Python 3 和 Node.js。"""

from copy import deepcopy
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from portrait_scene import avatar_styles, by_id, dog_avatar, portrait_data, species_scene

PROTOTYPE = Path(__file__).resolve().parents[1] / "prototype"


def avatar(scene, styles, patterns, portrait):
    cat = portrait["id"]
    shape = portrait.get("shape", {})
    head = by_id(scene, "cat-head")
    root = ET.Element("svg", {"xmlns": "http://www.w3.org/2000/svg",
                              "viewBox": "244 12 312 284", "data-cat": cat,
                              "data-art-style": "line"})
    ET.SubElement(root, "style").text = styles
    defs = ET.SubElement(root, "defs")
    for clip in ("clip-head", "clip-eye-l", "clip-eye-r"):
        defs.append(by_id(scene, clip))
    defs.extend(ET.fromstring(markup) for markup in patterns)

    head_scale = shape.get("headSX", 1)
    pose = ET.SubElement(root, "g", {"id": "scene", "transform":
                         f"rotate(-4 400 262) translate(400 262) scale({head_scale} 1) translate(-400 -262)"})
    for side, pivot in (("l", 322), ("r", 478)):
        ear = by_id(head, f"ear-{side}")
        ear_scale = shape.get("ear", 1)
        if ear_scale != 1:
            ear[0].set("transform", f"translate({pivot} 110) scale({ear_scale}) translate({-pivot} -110)")
        pose.append(ear)
    pose.append(by_id(head, "head-fill"))
    markings = by_id(head, "coat-head-patterns")
    if "head" in portrait:
        markings.extend(ET.fromstring(f"<g>{portrait['head']}</g>"))
    pose.append(markings)
    pose.append(by_id(head, "head-line"))

    eyes = dict(zip(("eye-l-open", "eye-r-open"), portrait.get("eyes", [])))
    # Keep the original paint order when extracting the cat's grouped face.
    for layer in head:
        if layer.get("data-species-face") == "cat":
            pose.extend(layer)
            continue
        child = layer
        node_id = child.get("id")
        if node_id in ("eye-l-open", "eye-r-open"):
            if node_id in eyes:
                child.insert(0, ET.fromstring(eyes[node_id]))
            pose.append(child)
        elif child.get("class") in ("blush", "coat-cow-marking", "whisker", "fang",
                                    "ink-thin coat-mouth-line", "ink-thin coat-nose"):
            pose.append(child)
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8") + b"\n"


def main():
    portraits = portrait_data(PROTOTYPE)
    cats = [portrait for portrait in portraits if portrait["species"] == "cat"]
    patterns = [portrait["defs"] for portrait in cats if "defs" in portrait]
    scene = species_scene(PROTOTYPE, "parts-cat")
    styles = avatar_styles(PROTOTYPE)
    # 线条头像用不到只在毛绒画风生效的规则（如英短蓝的眨眼眼皮色），去掉免得头像里留着无效样式。
    styles = re.sub(r'^svg[^{\n]*:not\(\[data-art-style="line"\]\)[^{\n]*\{[^}]*\}\n', "", styles, flags=re.M)
    directory = PROTOTYPE / "cats" / "line"
    directory.mkdir(parents=True, exist_ok=True)
    for portrait in cats:
        write_avatar(directory / f"{portrait['id']}.svg", avatar(deepcopy(scene), styles, patterns, portrait))
    for portrait in portraits:
        coat = portrait["id"]
        if portrait["species"] != "dog" or (PROTOTYPE / "art" / coat / "head.webp").is_file():
            continue
        root = dog_avatar(PROTOTYPE, portrait)
        ET.indent(root)
        write_avatar(PROTOTYPE / "cats" / f"{coat}.svg", ET.tostring(root, encoding="utf-8") + b"\n")


def write_avatar(path, contents):
    if not path.exists() or path.read_bytes() != contents:
        path.write_bytes(contents)
    print(path.relative_to(PROTOTYPE))


if __name__ == "__main__":
    main()
