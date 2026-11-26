"""Load the cat SVG for the offline avatar generators."""
import xml.etree.ElementTree as ET


def cat_scene(prototype):
    page = (prototype / "index.html").read_text()
    start = page.index('<svg id="scene"')
    scene = ET.fromstring(page[start:page.index("</svg>", start) + 6])
    template = page.split('<template id="parts-cat">', 1)[1].split("</template>", 1)[0]
    parts = {node.get("data-part"): node for node in ET.fromstring(template)}
    for slot in scene.findall(".//*[@data-part]"):
        slot.extend(parts[slot.attrib.pop("data-part")])
    return scene
