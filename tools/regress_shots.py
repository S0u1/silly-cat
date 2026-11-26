"""Capture deterministic stage renders and compare them in decoded RGB space."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlencode

from PIL import Image, ImageChops, ImageDraw

from readme_images import CATS, CLOCK, ROOT, renderer

OUTPUT = ROOT / '.art-src/regress'
# The hidden web controls poll __cat on a real interval. Its getters can enter
# a sleep stage before the first simulated frame, shifting Zs and drool by a tick.
REGRESSION_CLOCK = CLOCK + '\nwindow.setInterval = () => 0;'
DEMOS = {
    'tail-mouse': [0, 530, 2250, 4200, 4900],
    'push': [0, 1700, 2960, 3500, 5100], 'push-back': [0, 300, 600],
    'drool': [0, 800, 1800], 'slump-in': [0, 1700, 3500, 4700],
    'slumped': [0, 600, 1800], 'wake-marks': [0, 1200, 5700],
    'tired': [0, 800, 1500], 'angry': [0, 800, 1500], 'sigh': [0, 800, 1550],
    'rage': [0, 900, 2100, 2960], 'strike': [0, 150, 1600],
    'repair': [0, 220, 1100, 2110],
}


DOGS = ['tianyuan']
DOG_DEMOS = {
    'paw-mouse': [0, 530, 1000, 2300, 4260, 4900],
    'tilt': [0, 900, 1850], 'pet': [0, 950],
    **{name: times for name, times in DEMOS.items()
       if name not in ('tail-mouse', 'push', 'push-back')},
}
DOG_MOUSE_RIGHT = (1000, 2300)
DOG_CLOSEUPS = ('idle', 'pet-950', 'paw-mouse-1000', 'tilt-900',
                'wake-marks-1200', 'strike-1600', 'slumped-600')


def dog_overview(dest, pet):
    # Show matching poses side by side, retaining full-resolution frames in each folder.
    poses = ['idle', *(f'type-{key}' for key in 'ajf'),
             *(f'pointer-{i}' for i in range(4)), 'gaze-left', 'gaze-right',
             *(f'{name}-{at}' for name, times in DOG_DEMOS.items() for at in times),
             *(f'paw-mouse-right-{at}' for at in DOG_MOUSE_RIGHT),
             'slumped-nod', 'slumped-melt', 'headphones-front', 'headphones-back']
    width, height, pairs_per_row = 162, 146, 5
    rows = (len(poses) + pairs_per_row - 1) // pairs_per_row
    sheet = Image.new('RGB', (width * pairs_per_row * 2, height * rows), '#f4f1ed')
    draw = ImageDraw.Draw(sheet)
    for i, pose in enumerate(poses):
        for j, style in enumerate(('fur', 'line')):
            x, y = ((i % pairs_per_row) * 2 + j) * width, i // pairs_per_row * height
            with Image.open(dest / pet / style / f'{pose}.png') as frame:
                frame.thumbnail((width, height - 22), Image.Resampling.LANCZOS)
                sheet.paste(frame, (x, y))
            draw.text((x + 6, y + height - 19), f'{style}  {pose}', fill='#302e2b')
    sheet.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
    sheet.save(dest / 'overview.jpg', quality=85)


def dog_closeups(dest, pet):
    width, height, label, columns = 800, 620, 24, 4
    sheet = Image.new('RGB', (width * columns, (height + label) * 2), '#f4f1ed')
    draw = ImageDraw.Draw(sheet)
    for i, pose in enumerate(DOG_CLOSEUPS):
        x, y = i % columns * width, i // columns * (height + label)
        with Image.open(dest / pet / 'fur' / f'{pose}.png') as frame:
            if frame.size != (width, height):
                raise ValueError(f'{pose}: expected an 800 × 620 source frame')
            sheet.paste(frame, (x, y + label))
        draw.text((x + 8, y + 6), pose, fill='#302e2b')
    sheet.save(dest / 'closeups.jpg', quality=85)


def capture_pair(open_page, dest, cat, style):
    folder = dest / cat / style
    folder.mkdir(parents=True, exist_ok=True)

    def page(**params):
        return open_page((400, 310), urlencode(dict(cat=cat, style=style, **params)), False)

    with page() as (ev, shot):
        ev("advance(15)")
        shot().save(folder / 'idle.png')
        for key in 'ajf':
            ev(f"stroke('{key}',true), advance(5)")
            shot().save(folder / f'type-{key}.png')
            ev(f"stroke('{key}',false), advance(3)")
        for i, (event, x, y, buttons) in enumerate([
            ('pointermove', .1, .2, 0), ('pointermove', .85, .72, 0),
            ('pointerdown', .5, .3, 1), ('pointermove', .55, .32, 1),
        ]):
            ev(f"""document.querySelector('#cat-head').dispatchEvent(new PointerEvent(
                '{event}',{{bubbles:true,pointerType:'mouse',pointerId:1,button:0,
                buttons:{buttons},clientX:innerWidth*{x},clientY:innerHeight*{y}}})), advance(12)""".replace('\n', ' '))
            shot().save(folder / f'pointer-{i}.png')
    capture_gaze(open_page, dest, cat, style)
    for demo, times in (DOG_DEMOS if cat in DOGS else DEMOS).items():
        for at in times:
            with page(demo=demo, at=at) as (ev, shot):
                ev(f"advance({max(1, round(at * .06))})")
                shot().save(folder / f'{demo}-{at}.png')
    if cat in DOGS:
        for at in DOG_MOUSE_RIGHT:
            with page(demo='paw-mouse', at=at) as (ev, shot):
                ev("document.getElementById('mouse-left').click()")
                ev(f"advance({round(at * .06)})")
                shot().save(folder / f'paw-mouse-right-{at}.png')
        for pose in ('nod', 'melt'):
            with page(demo='slumped', **{'slump-style': pose}) as (ev, shot):
                ev("advance(90)")
                shot().save(folder / f'slumped-{pose}.png')
    for face, params in [('front', {}), ('back', {'demo': 'strike'})]:
        with page(listen=1, hpcolor='mint', **params) as (ev, shot):
            ev('advance(40)')
            shot().save(folder / f'headphones-{face}.png')


def capture_gaze(open_page, dest, cat, style):
    # Typing owns the gaze for 1.2 seconds. Use an untouched page for mouse tracking.
    with open_page((400, 310), urlencode(dict(cat=cat, style=style)), False) as (ev, shot):
        positions = []
        for name, x in [('left', 0.05), ('right', 0.95)]:
            ev(f"window.dispatchEvent(new PointerEvent('pointermove', {{pointerType:'mouse',clientX:innerWidth*{x},clientY:innerHeight*.4}})), advance(18)")
            positions.append(float(ev("document.querySelector('#pupil-l').getAttribute('cx')")))
            shot().save(dest / cat / style / f'gaze-{name}.png')
        if positions[0] >= positions[1]:
            raise ValueError(f'{cat}/{style}: pupil did not follow horizontal motion')


def capture(args):
    dest = args.out.resolve()
    if OUTPUT.resolve() not in dest.parents or any(dest.glob('**/*.png')):
        raise ValueError('Use a fresh directory inside .art-src/regress/')
    def run(pair):
        with TemporaryDirectory() as tmp, renderer(args.offline_webkit, Path(tmp), clock=REGRESSION_CLOCK) as open_page:
            @contextmanager
            def regression_page(*params):
                with open_page(*params) as (ev, shot):
                    # Browser screenshots yield to the compositor. Sample the settled key
                    # position, independent of screenshot latency and CSS wall-clock time.
                    if not args.offline_webkit:
                        ev("""document.head.appendChild(document.createElement('style')).textContent =
                            '#scene .key { transition: none !important; animation: none !important }'""")
                    if ev("typeof __cat") != 'object':
                        raise RuntimeError(f'{pair}: stage failed to initialize')
                    if ev("document.documentElement.dataset.cat") != pair[0]:
                        raise RuntimeError(f'{pair}: requested coat did not load')
                    ev("""(window.captureErrors = [], window.addEventListener('error',
                        e => captureErrors.push(e.message)), console.error = (...args) =>
                        captureErrors.push(args.map(String).join(' ')), true)""".replace('\n', ' '))
                    yield ev, shot
                    errors = ev("window.captureErrors")
                    if errors:
                        raise RuntimeError(f'{pair}: {errors}')
            capture_pair(regression_page, dest, *pair)
    pets = [cat for cat, _ in CATS] if args.pets in ('cats', 'all') else []
    if args.pets in ('dogs', 'all'):
        pets.extend(DOGS)
    pairs = [(cat, style) for cat in pets for style in ('fur', 'line')]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(run, pairs))
    if args.pets in ('dogs', 'all'):
        dog_overview(dest, 'tianyuan')
        dog_closeups(dest, 'tianyuan')
    print(f'{len(list(dest.rglob("*.png")))} screenshots')


def compare(args):
    paths = lambda root: {p.relative_to(root) for p in root.rglob('*.png')}
    a, b = paths(args.before), paths(args.after)
    if not a or not b:
        raise ValueError('Empty capture directory')
    failures = 0
    for path in sorted(a | b):
        if path not in a or path not in b:
            print(path, 'missing from', args.before if path not in a else args.after)
        else:
            with Image.open(args.before / path) as first, Image.open(args.after / path) as second:
                if first.size == second.size:
                    diff = ImageChops.difference(first.convert('RGB'), second.convert('RGB'))
                    if not diff.getbbox():
                        continue
                    r, g, blue = diff.split()
                    mask = ImageChops.lighter(ImageChops.lighter(r, g), blue)
                    print(path, mask.width * mask.height - mask.histogram()[0], 'different pixels')
                    target = OUTPUT / f'diff-{args.before.name}-{args.after.name}' / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    mask.point(lambda v: 255 if v else 0).save(target)
                else:
                    print(path, 'size mismatch', first.size, second.size)
        failures += 1
    print(f'{failures}/{len(a | b)} mismatches')
    return bool(failures)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    cap = commands.add_parser('capture')
    cap.add_argument('--out', type=Path, required=True)
    cap.add_argument('--offline-webkit', action='store_true')
    cap.add_argument('--pets', choices=('cats', 'dogs', 'all'), default='cats')
    cap.add_argument('--jobs', type=int, default=4)
    cap.set_defaults(action=capture)
    cmp = commands.add_parser('compare')
    cmp.add_argument('before', type=Path)
    cmp.add_argument('after', type=Path)
    cmp.set_defaults(action=compare)
    args = parser.parse_args()
    raise SystemExit(args.action(args))
