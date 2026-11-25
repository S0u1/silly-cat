"""耳机验收图。运行 python3 tools/headphones_check.py。
Playwright WebKit 在沙箱中无法启动时，加 --offline-webkit 用系统 WebKit 离屏渲染。
"""
import argparse
import base64
import io
import json
import select
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from functools import partial
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
from readme_images import CATS, CLOCK, NATIVE, ROOT, SCENE_STYLE, WEB

OUTPUT = ROOT / '.art-src/headphones-check'
BG = '#fbf6ea'
BASE_H = 1368
# 沿用 README 的固定随机种子与虚拟钟，最后一小步对齐指定毫秒。
CLOCK += """
window.advanceTo = at => {
  const tick = at * 60 / 1000;
  if (tick < simTick) throw new Error('Cannot rewind');
  advance(Math.floor(tick - simTick));
  if (simTick !== tick || at === 0) {
    simTick = tick;
    const pending = callbacks; callbacks = [];
    for (const fn of pending) fn(performance.now());
  }
};
window.sceneErrors = [];
addEventListener('error', e => sceneErrors.push(e.message));
console.error = (...args) => sceneErrors.push(args.map(String).join(' '));
"""
SETTINGS_STUB = """
window.probeCalls = 0;
window.__TAURI__ = { event: {listen: async () => () => {}}, core: { invoke: async cmd => {
  if (cmd === 'media_activity') {
    probeCalls++;
    if (PROBE === 'error') throw new Error('IPC failed');
    if (PROBE === 'timeout') return new Promise(() => {});
    return {supported: PROBE === 'supported', active: false, via: 'test'};
  }
  return {updater_configured: true, autostart_status: {platform: PLATFORM, supported: true, enabled: false},
          app_version: 'QA', input_status: {needs_permission: false}}[cmd] ?? null;
} } };
"""
SELECTOR = {'front': '#cat-head > .hp-headset', 'back': '#strike-head-shape > .hp-headset'}
CASES = [
    ('醒着 · 摆头', {}, 2700, 'awake', None),
    ('犯困', {'sleep': 4}, 2850, 'drowsy', None),
    ('坐着睡', {'sleep': 4}, 5100, 'asleep', 'sitting'),
    ('流口水', {'demo': 'drool'}, 2000, 'asleep', 'drool'),
    ('点头栽倒', {'demo': 'slump-in', 'slump-style': 'nod', 'at': 2600}, 500, 'asleep', 'slumped'),
    ('融化摊平', {'demo': 'slumped', 'slump-style': 'melt'}, 500, 'asleep', 'slumped'),
    ('发飙砸键盘', {'demo': 'rage', 'at': 560}, 500, 'rage', None),
    ('罢工背影', {'demo': 'strike'}, 500, 'strike', None),
    ('被摸', {}, 2750, 'petted', None),
]


def capture_png(raw):
    with Image.open(io.BytesIO(raw)) as im:
        return im.convert('RGB')


@contextmanager
def playwright_page(browser, size, name, query, init):
    page = browser.new_page(viewport=dict(zip(('width', 'height'), size)))
    page.add_init_script(init)
    url = (WEB / name).as_uri() + ('?' + urlencode(query) if query else '')
    try:
        page.goto(url, wait_until='load', timeout=12000)
        yield page.evaluate, lambda: capture_png(page.screenshot(timeout=12000))
    finally:
        page.close()


@contextmanager
def native_page(binary, tmp, size, name, query, init):
    html = (WEB / name).read_text()
    if name == 'settings.html':
        # 系统 WebView 的 loadHTMLString 对本地 HTML img 有额外限制，嵌入原图以保留设置页头像。
        avatars = {}
        for directory in ('cats', 'cats/line'):
            for path in (WEB / directory).glob('*.svg'):
                avatars[f'{directory}/{path.name}'] = (
                    'data:image/svg+xml;base64,' + base64.b64encode(path.read_bytes()).decode())
        html = html.replace('img.src = `${directory}/${id}.svg`',
                            f'img.src = ({json.dumps(avatars)})[`${{directory}}/${{id}}.svg`]')
    html = html.replace('new URLSearchParams(location.search)',
                        f'new URLSearchParams({json.dumps(urlencode(query))})')
    html = html.replace('</head>', f'<script>{init}</script></head>')
    path = tmp / 'page.html'
    path.write_text(html)
    proc = subprocess.Popen([binary, *map(str, size), path, WEB],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def request(command):
        proc.stdin.write(command + '\n')
        proc.stdin.flush()
        if not select.select([proc.stdout], [], [], 12)[0]:
            raise TimeoutError(command[:80])
        result = proc.stdout.readline().strip()
        if not result:
            raise RuntimeError(f'WebKit command failed: {command[:120]}')
        return result

    def evaluate(code):
        expression = ' '.join(code.splitlines())
        return json.loads(request(f'JSON.stringify(({expression}) ?? null)'))

    def capture():
        frame = tmp / 'capture.png'
        if request('SHOT ' + str(frame)) != 'ok':
            raise RuntimeError('WebKit snapshot failed')
        return capture_png(frame.read_bytes())

    try:
        yield evaluate, capture
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


@contextmanager
def renderer(offline):
    if offline:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            source = tmp / 'reader.m'
            source.write_text(NATIVE.replace('width * 2, height * 2', 'width, height')
                              .replace('if ([command hasPrefix:@"SHOT "]) {',
                                       'pump(.02); if ([command hasPrefix:@"SHOT "]) {'))
            binary = tmp / 'reader'
            subprocess.run(['clang', '-w', '-framework', 'WebKit', '-framework', 'Cocoa',
                            str(source), '-o', str(binary)], check=True, timeout=30)
            yield partial(native_page, binary, tmp)
    else:
        with sync_playwright() as pw:
            browser = pw.webkit.launch(timeout=12000)
            try:
                yield partial(playwright_page, browser)
            finally:
                browser.close()


@contextmanager
def scene(open_page, size, params, viewbox='130 -40 540 648', extra_init=''):
    query = dict(cat='cow', style='fur', listen=1, push=0, work=900, statusbar=0) | params
    with open_page(size, 'index.html', query, CLOCK + extra_init) as (ev, capture):
        ev(f"""(() => {{
            const style = document.createElement('style');
            style.textContent = {json.dumps(SCENE_STYLE)};
            document.head.appendChild(style);
            document.querySelector('#scene').setAttribute('viewBox', '{viewbox}');
            return true;
        }})()""")
        yield ev, lambda: capture().resize(size, Image.Resampling.LANCZOS)
        assert not (errors := ev('sceneErrors')), errors


def wait_until(ev, expression, timeout=5):
    deadline = time.monotonic() + timeout
    while not ev(expression):
        if time.monotonic() > deadline:
            raise TimeoutError(expression)
        time.sleep(0.02)


def wait_for_art(ev):
    ev("""(() => {
      const hrefs = new Set([...document.querySelectorAll('#scene image[href]')].map(
        el => el.getAttribute('href')));
      window.artProbes = [...hrefs].map(href => {
        const image = new Image();
        image.src = href;
        return image;
      });
    })()""")
    wait_until(ev, 'artProbes.every(img => img.complete && img.naturalWidth > 0)')


def headset(ev, facing='front'):
    return ev(rf"""(() => {{
      const g = document.querySelector('{SELECTOR[facing]}');
      return {{ opacity: Number(g.getAttribute('opacity')), display: g.style.display,
                y: Number(g.getAttribute('transform')?.match(/translate\(0 ([^)]+)/)?.[1]),
                cups: g.querySelectorAll('.hp-cup').length }};
    }})()""")


def assert_worn(ev, facing='front'):
    result = headset(ev, facing)
    assert result == {'opacity': 1, 'display': '', 'y': 0, 'cups': 2}, (facing, result)


def font(size):
    for path in ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc'):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def sheet(rows, names, path):
    w, h = rows[0][0].size
    caption_h = 24
    grid = Image.new('RGB', (w * len(rows[0]), (h + caption_h) * len(rows)), BG)
    assert grid.width <= 1800
    draw = ImageDraw.Draw(grid)
    caption = font(13)
    for row, (frames, labels) in enumerate(zip(rows, names)):
        for col, (frame, label) in enumerate(zip(frames, labels)):
            x, y = col * w, row * (h + caption_h)
            grid.paste(frame, (x, y))
            draw.text((x + w / 2, y + h + caption_h / 2), label, font=caption,
                      fill='#1d1b22', anchor='mm')
    grid.save(OUTPUT / path, optimize=True)


def coats(open_page, style):
    frames = []
    with scene(open_page, (340, 260), {'style': style}, '65 -33 670 627') as (ev, capture):
        for cat, _ in CATS:
            ev(f"SillyCoats.apply('{cat}'), advance(8)")
            assert_worn(ev)
            assert ev("Boolean(document.querySelector('#cat-head > image'))") == (style == 'fur')
            assert ev("document.querySelector('#cat-head').lastElementChild.matches('.hp-headset')")
            wait_for_art(ev)
            frames.append(capture())
    labels = [name for _, name in CATS]
    sheet([frames[:5], frames[5:]], [labels[:5], labels[5:]], f'{style}-10.png')


def states(open_page):
    featured = [CATS[i] for i in (0, 3, 8, 9)]
    frames = [[] for _ in featured]
    for label, params, at, state, stage in CASES:
        with scene(open_page, (196, 168), params, '85 -40 630 635') as (ev, capture):
            for row, (cat, _) in enumerate(featured):
                ev(f"SillyCoats.apply('{cat}')")
                if row == 0:
                    if state == 'petted':
                        ev("""advanceTo(2300), document.querySelector('#head-fill').dispatchEvent(
                          new PointerEvent('pointerdown', {bubbles:true, pointerId:1, pointerType:'mouse',
                          clientX:innerWidth/2, clientY:innerHeight*.3, button:0, buttons:1}))""")
                    ev(f'advanceTo({at})')
                else:
                    ev('advance(1)')
                assert ev('__cat.state') == state, (label, ev('__cat.state'))
                if stage:
                    assert ev('__cat.sleepStage') == stage, (label, ev('__cat.sleepStage'))
                assert_worn(ev, 'back' if state == 'strike' else 'front')
                if state != 'awake':
                    assert ev("document.querySelectorAll('.hp-note').length") == 0, label
                wait_for_art(ev)
                frames[row].append(capture())
    sheet(frames, [[f'{name} · {case[0]}' for case in CASES] for _, name in featured], 'states.png')


def animation(open_page):
    frames, labels = [], []
    with scene(open_page, (196, 166), {'listen': 'cycle', 'sleep': 120}, '225 -22 350 312') as (ev, capture):
        wait_for_art(ev)
        for at in (0, 90, 180, 270, 360, 610, 8000, 8140, 8280):
            ev(f'advanceTo({at})')
            result = headset(ev)
            alpha = result['opacity']
            if at == 0:
                assert alpha == 0 and result['y'] < -40, result
            if at == 90:
                assert abs(alpha - 0.75) < 1e-6 and result['y'] < 0, result
            if at == 180:
                assert alpha == 1 and result['y'] > 0, result
            if at in (360, 8000):
                assert_worn(ev)
            if at == 610:
                assert ev("document.querySelectorAll('.hp-note').length") == 1
            if at == 8140:
                assert abs(alpha - 0.5) < 1e-6 and result['y'] < 0, result
            if at == 8280:
                assert alpha == 0 and result['display'] == 'none', result
            labels.append(f'戴上 {at} ms' if at <= 360 else '落定后音符' if at == 610 else f'摘下 {at-8000} ms')
            frames.append(capture())
    sheet([frames], [labels], 'anim.png')


def check_motion(open_page):
    def head_transform(ev):
        return ev("document.querySelector('#cat-head').getAttribute('transform')")

    with scene(open_page, (196, 166), {}) as (ev, _):
        ev('advanceTo(2700)')
        assert 'rotate(-0.80 ' in head_transform(ev)
        ev("stroke('a',true), advanceTo(2800)")
        assert 'rotate(-4.00 ' not in head_transform(ev), 'input must ease out the sway'
        ev("stroke('a',false), advanceTo(3100)")
        assert 'rotate(-4.00 ' in head_transform(ev), 'sway must stop within 400 ms'

    with scene(open_page, (196, 166), {'listen': 'cycle', 'sleep': 120},
               extra_init="window.matchMedia = () => ({matches:true});") as (ev, _):
        for at, opacity in ((0, 0), (100, 0.5), (200, 1), (2700, 1), (8100, 0.5), (8200, 0)):
            ev(f'advanceTo({at})')
            frame = headset(ev)
            assert frame['y'] == 0 and frame['opacity'] == opacity, (at, frame)
            assert 'rotate(-4.00 ' in head_transform(ev)
            assert ev("document.querySelectorAll('.hp-note').length") == 0

    params = {'demo': 'push', 'at': 1800}
    with scene(open_page, (196, 166), params) as (ev, _):
        ev('advanceTo(2700)')
        assert_worn(ev)
        pushing = head_transform(ev)
    with scene(open_page, (196, 166), params | {'listen': 0}) as (ev, _):
        ev('advanceTo(2700)')
        assert head_transform(ev) == pushing, 'push pose should match with and without headphones'


def settings(open_page):
    layout = """(() => {
      const bottom = (sel) => Math.ceil(document.querySelector(sel).getBoundingClientRect().bottom);
      return { viewport: innerHeight, content: Math.ceil(document.body.getBoundingClientRect().height),
        about: bottom('#about'), reset: bottom('#reset'),
        hidden: document.querySelector('[data-bool="headphones"]').hidden,
        checked: document.querySelector('#f-headphones').checked,
        probes: window.probeCalls ?? 0 };
    })()"""
    configurations = [('supported', 'macos'), ('supported', 'windows'), ('unsupported', 'macos'),
                      ('error', 'macos'), ('timeout', 'macos'), (None, None)]
    for probe, platform in configurations:
        stub = SETTINGS_STUB.replace('PROBE', json.dumps(probe)).replace('PLATFORM', json.dumps(platform))
        init = CLOCK + (stub if probe else '')
        with open_page((400, BASE_H), 'settings.html', {}, init) as (ev, capture):
            wait_until(ev, "[...document.images].every(img => img.complete && img.naturalWidth > 0)")
            if probe == 'timeout':
                # 真正经过 IPC 超时后再核对可见性。
                wait_until(ev, "Date.now() >= (window.probeDeadline ??= Date.now() + 2020)")
            dims = ev(layout)
            assert dims['probes'] == (1 if probe else 0), dims
            assert dims['hidden'] == (probe == 'unsupported') and not dims['checked'], dims
            assert not (errors := ev('sceneErrors')), errors
            if probe == 'supported':
                baseline = ev("""(() => {
                    const row = document.querySelector('[data-bool="headphones"]');
                    row.hidden = true;
                    const height = Math.ceil(document.body.getBoundingClientRect().height);
                    row.hidden = false;
                    return height;
                })()""")
                print(f"settings ({platform}): viewport 400×{dims['viewport']}, content {dims['content']} px, "
                      f"about bottom {dims['about']} px, reset bottom {dims['reset']} px, "
                      f"without headphones row {baseline} px",
                      flush=True)
                assert dims['reset'] <= dims['viewport'] and dims['about'] <= dims['viewport'], dims
                if platform == 'macos':
                    capture().save(OUTPUT / 'settings.png', optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline-webkit', action='store_true')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with renderer(args.offline_webkit) as open_page:
        for style in ('fur', 'line'):
            coats(open_page, style)
        states(open_page)
        animation(open_page)
        check_motion(open_page)
        settings(open_page)
    print(OUTPUT)


if __name__ == '__main__':
    main()
