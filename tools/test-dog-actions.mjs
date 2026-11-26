import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, Script } from 'node:vm';

const read = (file) => readFileSync(new URL(`../prototype/${file}`, import.meta.url), 'utf8');
const scene = read('index.html');
const scripts = ['species.js', 'species-cat.js', 'species-dog.js', 'cat.js', 'push.js']
  .map((file) => new Script(read(file), { filename: file }));

function harness({ species = 'dog', demo = null, sleepSeconds = 60, random = 0.1, push = false } = {}) {
  let now = 0, nextFrame;
  const nodes = new Map(), keys = new Map();
  const sceneIds = (source) => Array.from(source.matchAll(/\bid="([\w-]+)"/g), (match) => match[1]);
  const createElement = () => {
    const attributes = new Map(), classes = new Set();
    return {
      attributes, style: {}, classes,
      setAttribute(key, value) { attributes.set(key, String(value)); },
      querySelector: () => createElement(),
      insertAdjacentHTML(position, html) {
        for (const id of sceneIds(html)) nodes.set(id, createElement());
      },
      appendChild() {}, remove() {},
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      },
    };
  };
  for (const id of sceneIds(scene)) nodes.set(id, createElement());

  const math = Object.create(Math);
  math.random = () => random;
  const sandbox = createContext({
    Math: math, navigator: { userAgent: 'test' },
    performance: { now: () => now },
    requestAnimationFrame(callback) { nextFrame = callback; },
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      querySelectorAll: () => [], createElementNS: createElement,
    },
    console: { error: (message, error) => assert.fail(`${message}: ${error.stack}`) },
    SillyArt: { arm() {}, cheek() {} }, SillyCoats: { current: () => ({}) },
  });
  sandbox.window = sandbox;
  for (const script of scripts) script.runInContext(sandbox);
  sandbox.SillySpecies.select(species);
  const keyboard = {
    center: (code) => ({ x: code === 'KeyG' ? 460 : 320, y: 474 }),
    setDown: (code, down) => keys.set(code, down),
  };
  const modules = push ? [(ctx) => sandbox.SillyPush.create(ctx, { demo, everySeconds: 5 })] : [];
  const pet = sandbox.SillyCat.createCat({ keyboard, eyesFollow: false, sleepSeconds, demo, modules });
  const update = (time) => { now = time; nextFrame(now); };
  update(0);
  return {
    pet, debug: pet.debug, keys,
    select: (id) => sandbox.SillySpecies.select(id),
    rig: () => sandbox.SillySpecies.current.rig,
    node: (id) => nodes.get(id),
    advance(time) {
      while (now + 16 < time) update(now + 16);
      update(time);
    },
    snapshot(ids) {
      return ids.map((id) => {
        const node = nodes.get(id);
        return [Array.from(node.attributes), { ...node.style }, Array.from(node.classes)];
      });
    },
  };
}

const pinned = (name, at) => ({ name, at, loop: false });
const translate = (node) => node.attributes.get('transform').match(/^translate\(([-.\d]+) ([-.\d]+)\)/).slice(1).map(Number);

test('dog uses the mouse-side paw and gives that side’s typing priority', () => {
  const h = harness();
  h.pet.pointerMove(20, -12);
  h.advance(260);
  assert.equal(h.debug.paws.right, 'mouse');
  assert.equal(h.debug.paws.left, 'rest');
  assert.equal(h.debug.tail, 'idle');
  assert.equal(h.debug.tailReach, 0);
  const [x, y] = translate(h.node('mouse'));
  const [px, py] = translate(h.node('paw-l'));
  assert.ok(Math.abs(px - x) < 1 && Math.abs(py - y - 4) < 1);

  h.pet.keyDown('KeyG');
  assert.equal(h.debug.paws.left, 'KeyG');
  assert.equal(h.debug.paws.right, 'mouse');
  h.pet.pointerDown(2);
  h.advance(480);
  assert.ok(h.node('mouse-btn-r').classes.has('down'));
  assert.ok(translate(h.node('paw-l'))[0] < translate(h.node('mouse'))[0] - 8);
  h.pet.keyDown('KeyK');
  assert.equal(h.debug.paws.right, 'KeyK');
  h.pet.keyUp('KeyK');
  h.advance(599);
  assert.equal(h.debug.paws.right, 'KeyK');
  h.advance(600);
  assert.equal(h.debug.paws.right, 'mouse');
  h.pet.pointerUp(2);
  h.pet.keyUp('KeyG');
  h.advance(2100);
  assert.equal(h.debug.paws.right, 'rest');
  assert.ok(!h.node('mouse-btn-r').classes.has('down'));

  h.pet.setMouseSide('left');
  h.pet.pointerMove(-8, 12);
  h.advance(2360);
  assert.equal(h.debug.paws.left, 'mouse');
  assert.equal(h.debug.paws.right, 'rest');
  assert.ok(translate(h.node('paw-r'))[0] > 690);
  h.pet.keyDown('KeyG');
  assert.equal(h.debug.paws.left, 'KeyG');
  h.pet.keyUp('KeyG');
  h.advance(2480);
  assert.equal(h.debug.paws.left, 'mouse');
});

test('dog wag tracks typing over seconds, accelerates for petting and stops in sleep', () => {
  const h = harness({ sleepSeconds: 6 });
  const base = h.debug.tailWagHz;
  const limit = h.rig().tail.wag.excited.speed * 1000 / (2 * Math.PI);
  for (let time = 40; time <= 480; time += 40) {
    h.advance(time);
    h.pet.keyDown('KeyG'); h.pet.keyUp('KeyG');
  }
  h.advance(1000);
  assert.ok(h.debug.tailWagHz > base && h.debug.tailWagHz < limit);
  for (let time = 1020; time <= 2600; time += 20) {
    h.advance(time);
    h.pet.keyDown('KeyK'); h.pet.keyUp('KeyK');
  }
  assert.ok(h.debug.tailWagHz > limit * 0.99 && h.debug.tailWagHz <= limit);
  h.pet.petStart(0, 0);
  h.advance(2650);
  assert.equal(h.debug.state, 'petted');
  assert.ok(h.debug.tailWagHz > limit);
  assert.equal(h.node('dog-tongue').style.display, '');
  assert.equal(h.node('eye-l-happy').style.display, '');
  h.pet.petEnd();
  h.advance(6000);
  assert.ok(h.debug.tailWagHz < limit);
  assert.equal(h.node('dog-tongue').style.display, 'none');
  h.advance(8650);
  assert.equal(h.debug.state, 'asleep');
  assert.equal(h.debug.tailWagHz, 0);
  const tail = h.node('tail-body').attributes.get('d');
  h.pet.pointerMove(24, 0);
  h.advance(9500);
  assert.equal(h.debug.state, 'asleep');
  assert.equal(h.debug.paws.right, 'rest');
  assert.equal(h.node('tail-body').attributes.get('d'), tail);
});

test('dog tilt waits for quiet, lasts 1.5s and cannot repeat within the same idle period', () => {
  const h = harness({ sleepSeconds: 120 });
  h.advance(5900);
  h.pet.pointerMove(1, 0);
  h.advance(11899);
  assert.equal(h.debug.tilt, 0);
  h.advance(12200);
  assert.equal(Math.abs(h.debug.tilt), 12);
  h.advance(13415);
  assert.equal(h.debug.tilt, 0);
  h.pet.pointerMove(1, 0);
  h.advance(20500);
  assert.equal(h.debug.tilt, 0);
  h.advance(40000);
  assert.equal(h.debug.tilt, 0);
  h.pet.pointerMove(1, 0);
  h.advance(46300);
  assert.equal(Math.abs(h.debug.tilt), 12);
  h.pet.keyDown('KeyG');
  h.advance(46700);
  assert.ok(Math.abs(h.debug.tilt) < 0.1);

  const sleepy = harness({ sleepSeconds: 10 });
  sleepy.advance(6800);
  assert.equal(sleepy.debug.state, 'drowsy');
  assert.equal(sleepy.debug.tilt, 0);
  const noTilt = harness({ random: 0.9 });
  noTilt.advance(6800);
  assert.equal(noTilt.debug.tilt, 0);
});

test('fixed demos keep the pose, while the existing cat mouse and cat pet demos still work', () => {
  const click = harness({ demo: pinned('paw-mouse', 2300) });
  assert.equal(click.debug.paws.right, 'mouse');
  assert.equal(click.debug.tail, 'idle');
  assert.equal(click.node('mouse-btn-l').classes.has('down'), true);
  assert.deepEqual(translate(click.node('paw-l')), [113, 493]);
  const nodes = ['cat-head', 'paw-l', 'tail-body', 'mouse', 'mouse-btn-l'];
  const frame = click.snapshot(nodes);
  click.pet.keyDown('KeyK');
  click.advance(6000);
  assert.deepEqual(click.snapshot(nodes), frame);

  const tilt = harness({ demo: pinned('tilt', 900) });
  assert.equal(tilt.debug.tilt, 12);
  assert.equal(harness({ demo: pinned('tilt', 1800) }).debug.tilt, 0);
  assert.equal(harness({ demo: { name: 'tilt', loop: false } }).debug.tilt, 0);
  const legacy = harness({ species: 'cat', demo: pinned('tail-mouse', 2300) });
  assert.equal(legacy.debug.tail, 'on-mouse');
  assert.equal(legacy.debug.paws.right, 'rest');
  assert.equal(legacy.node('mouse-btn-l').classes.has('down'), true);
  for (const species of ['cat', 'dog']) {
    const pet = harness({ species, demo: pinned('pet', 950) });
    assert.equal(pet.debug.state, 'petted');
    assert.equal(pet.node('eye-l-happy').style.display, '');
    assert.equal(pet.node('dog-tongue').style.display, species === 'dog' ? '' : 'none');
    const held = pet.snapshot(nodes);
    pet.advance(4000);
    assert.deepEqual(pet.snapshot(nodes), held);
  }
  const once = harness({ demo: { name: 'paw-mouse', loop: false } });
  once.advance(5400);
  once.pet.pointerMove(8, 0);
  assert.equal(once.debug.paws.right, 'mouse');
});

test('switching to dog disables cup action, including a forced demo, and cats keep it', () => {
  const h = harness({ species: 'cat', push: true, demo: pinned('push', 1200) });
  assert.equal(h.debug.pushPhase, 'tap');
  assert.equal(h.node('mug').style.display, '');
  h.select('dog');
  h.advance(32);
  assert.equal(h.debug.pushPhase, 'disabled');
  assert.equal(h.debug.nextPushIn, null);
  assert.equal(h.node('mug').style.display, 'none');
  h.pet.keyDown('KeyK');
  assert.equal(h.keys.get('KeyK'), true);
  h.pet.keyUp('KeyK');
  h.select('cat');
  h.advance(180);
  assert.equal(h.debug.pushPhase, 'tap');
  assert.equal(h.node('mug').style.display, '');
});
