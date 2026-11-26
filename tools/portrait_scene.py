"""Load the scene parts and coat data used by the offline avatar generators."""
import json
import subprocess
import xml.etree.ElementTree as ET


# Evaluate the coat registry without starting the application.
READ_PORTRAITS = """
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const node = { insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() {}, style: {} };
const context = {
  window: {},
  SillyArt: { apply() {} },
  document: {
    documentElement: { dataset: {} },
    getElementById: () => node,
    querySelector: () => node,
    querySelectorAll: () => [],
  },
};
for (const file of ['species.js', 'species-cat.js', 'species-dog.js', 'coats.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(process.argv[1], file), 'utf8'), context);
}
const { SillyCoats, SillySpecies } = context.window;
const portraits = SillyCoats.list().map(({ id, species }) => {
  const coat = SillyCoats.setArtStyle(species === 'cat' ? 'line' : 'fur', id);
  const { defs, shape, head, eye, art } = coat;
  if (species === 'cat') return { id, species, defs, shape, head, eyes: eye && [eye(345), eye(455)] };
  const { rig, scene, coatShape } = SillySpecies.get(species);
  const { turnX, head: { pivot, restRotation, backPath }, eyes, ears } = rig;
  return {
    id, species, defs, shape: { ...coatShape, ...shape }, head, art, template: scene.template,
    rig: { turnX, head: { pivot, restRotation, backPath }, eyes,
      ears: { outline: ears.outline, innerPath: ears.innerPath } },
  };
});
console.log(JSON.stringify(portraits));
"""


def portrait_data(prototype):
    return json.loads(subprocess.check_output(["node", "-e", READ_PORTRAITS, str(prototype)], text=True))


def species_scene(prototype, template_id):
    page = (prototype / "index.html").read_text()
    start = page.index('<svg id="scene"')
    scene = ET.fromstring(page[start:page.index("</svg>", start) + 6])
    template = page.split(f'<template id="{template_id}">', 1)[1].split("</template>", 1)[0]
    parts = {name: node for node in ET.fromstring(template)
             for name in node.get("data-part", "").split()}
    for slot in scene.findall(".//*[@data-part]"):
        part = parts.get(slot.attrib.pop("data-part"))
        if part is not None:
            slot.extend(part)
    return scene


def by_id(tree, node_id):
    node = tree.find(f".//*[@id='{node_id}']")
    if node is None:
        raise ValueError(f"场景缺少 #{node_id}")
    return node


def avatar_styles(prototype, *extra_blocks):
    css = (prototype / "style.css").read_text(encoding="utf-8")
    return "\n".join(css.split(f"/* portrait-{block}:start */")[1]
                     .split(f"/* portrait-{block}:end */")[0].replace("html", "svg")
                     for block in ("palette", "face", *extra_blocks))


def dog_eyes(scene, eyes):
    for side, center in eyes["centers"].items():
        side = side.lower()
        cx, cy = center["x"], center["y"] + eyes["gaze"]["restY"]
        radius = eyes["radius"]
        eye = by_id(scene, f"puppy-{side}-open")
        eye.attrib.pop("style", None)
        for circle in (by_id(eye, f"puppy-{side}-pupil"), by_id(scene, f"clip-puppy-{side}")[0]):
            circle.attrib.update(cx=str(cx), cy=str(cy), r=str(radius))
        for name in ("shine", "glint"):
            detail = eyes[name]
            by_id(eye, f"puppy-{side}-{name}").attrib.update(
                cx=str(cx + detail["x"]), cy=str(cy + detail["y"]), r=str(detail["radius"]))
        # An avatar paints the fully open expression.
        for name in ("lid", "lidline"):
            eye.remove(by_id(eye, f"puppy-{side}-{name}"))


def dog_avatar(prototype, portrait, ear_images=(), head_image=None):
    scene = species_scene(prototype, portrait["template"])
    head = by_id(scene, "cat-head")
    rig = portrait["rig"]
    dog_eyes(scene, rig["eyes"])
    root = ET.Element("svg", {"xmlns": "http://www.w3.org/2000/svg",
                              "viewBox": "244 12 312 292", "data-cat": portrait["id"],
                              "data-art-style": "fur"})
    ET.SubElement(root, "style").text = avatar_styles(prototype, "dog")
    defs = ET.SubElement(root, "defs")
    outline = rig["head"]["backPath"]
    by_id(scene, "clip-head-path").set("d", outline)
    for clip in ("clip-head", "clip-puppy-l", "clip-puppy-r", "puppy-iris"):
        defs.append(by_id(scene, clip))
    defs.extend(ET.fromstring(f"<defs>{portrait['defs']}</defs>"))
    pivot = rig["head"]["pivot"]
    x, y = pivot["x"], pivot["y"]
    rotation = rig["head"]["restRotation"]
    scale = portrait["shape"]["headSX"]
    pose = ET.SubElement(root, "g", {"id": "scene", "transform":
        f"rotate({rotation} {x} {y}) translate({x} {y}) scale({scale} 1) translate({-x} {-y})"})
    if ear_images:
        pose.extend(ear_images)
    else:
        for path in head.findall(".//path"):
            if "dog-ear-outline" in path.get("class", "").split():
                path.set("d", rig["ears"]["outline"])
            elif "coat-inner-ear" in path.get("class", "").split():
                path.set("d", rig["ears"]["innerPath"])
        pose.extend(by_id(head, f"ear-{side}") for side in ("l", "r"))
    if head_image is not None:
        pose.append(head_image)
    else:
        fill, line = (by_id(head, layer) for layer in ("head-fill", "head-line"))
        fill.set("d", outline)
        line.set("d", outline)
        pose.append(fill)
        markings = ET.SubElement(pose, "g", {"clip-path": "url(#clip-head)"})
        markings.extend(ET.fromstring(f"<g>{portrait['head']}</g>"))
        pose.append(line)
    for layer in head:
        if layer.get("data-species-face") == portrait["species"]:
            layer.attrib.pop("style", None)
            pose.append(layer)
        elif layer.get("id") in ("puppy-l-open", "puppy-r-open"):
            pose.append(layer)
    return root
