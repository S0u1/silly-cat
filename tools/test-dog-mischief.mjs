import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './test-support/dog-scene.mjs';

const tapKey = (scene) => {
  scene.pet.keyDown('KeyK');
  scene.pet.keyUp('KeyK');
};

function translation(node) {
  const [, x, y] = node.getAttribute('transform').match(/^translate\(([-.\d]+) ([-.\d]+)\)/);
  return { x: Number(x), y: Number(y) };
}

function assertNearCenter(node, center, tolerance = 0.08) {
  const point = translation(node);
  assert.ok(Math.hypot(point.x - center.x, point.y - center.y) < tolerance,
    `expected (${point.x}, ${point.y}) to be near (${center.x}, ${center.y})`);
}

function waitForPhase(scene, phase, timeout = 8000) {
  const deadline = scene.now + timeout;
  while (scene.debug.pushPhase !== phase && scene.now < deadline) {
    scene.advance(Math.min(deadline, scene.now + 16));
  }
  assert.equal(scene.debug.pushPhase, phase);
  return scene.now;
}

test('the same schedule starts a cat cup push or a dog mouse snatch', () => {
  const cat = harness({ species: 'cat', push: true });
  const dog = harness({ push: true });
  for (const scene of [cat, dog]) {
    tapKey(scene);
    scene.advance(2400);
    assert.equal(scene.debug.pushPhase, 'idle');
    waitForPhase(scene, 'look');
  }
  waitForPhase(cat, 'tap');
  assert.equal(cat.node('mug').style.display, '');
  assert.equal(cat.debug.mouseSnatched, false);

  for (const phase of ['dip', 'lift', 'wag', 'turn', 'gone']) {
    waitForPhase(dog, phase);
    assert.equal(dog.node('mug').style.display, 'none');
  }
  assert.equal(dog.debug.mouseSnatched, true);
  assert.equal(dog.node('mouse').style.display, 'none');
});

test('the dog skips mouse paw and button input while the mouse is away, then returns it when petted', () => {
  const scene = harness({ push: true });
  tapKey(scene);
  waitForPhase(scene, 'gone');

  scene.pet.pointerMove(24, 12);
  scene.pet.pointerDown(0);
  scene.advance(scene.now + 160);
  assert.notEqual(scene.debug.paws.right, 'mouse');
  assert.equal(scene.node('mouse-btn-l').classes.has('down'), false);
  scene.pet.pointerUp(0);

  scene.pet.petStart(0, 0);
  scene.advance(scene.now + 120);
  assert.equal(scene.debug.pushPhase, 'return');
  assert.notEqual(scene.debug.paws.right, 'mouse');
  scene.pet.petEnd();
  waitForPhase(scene, 'idle');
  assert.equal(scene.debug.mouseSnatched, false);
  assert.equal(scene.node('mouse').style.display, '');
  scene.pet.pointerMove(24, 12);
  scene.pet.pointerDown(0);
  scene.advance(scene.now + 160);
  assert.equal(scene.debug.paws.right, 'mouse');
  assert.equal(scene.node('mouse-btn-l').classes.has('down'), true);
  scene.pet.pointerUp(0);
});

test('the untouched mouse stays away for 60 seconds and returns on the current mouse side', () => {
  const scene = harness({ push: true, sleepSeconds: 240 });
  tapKey(scene);
  const goneAt = waitForPhase(scene, 'gone');
  scene.pet.setMouseSide('left');
  scene.advance(goneAt + 59900);
  assert.equal(scene.debug.pushPhase, 'gone');
  assert.equal(scene.node('mouse').style.display, 'none');
  scene.advance(goneAt + 60100);
  assert.equal(scene.debug.pushPhase, 'return');
  waitForPhase(scene, 'idle');
  assert.equal(scene.node('mouse').style.display, '');
  const transform = scene.node('mouse').getAttribute('transform');
  assert.ok(Number(transform.match(/^translate\(([-.\d]+)/)[1]) > 400);
});

test('the mouse comes back without interrupting sleep when the return timer expires', () => {
  const scene = harness({ push: true, sleepSeconds: 20 });
  tapKey(scene);
  const goneAt = waitForPhase(scene, 'gone');
  scene.advance(goneAt + 59900);
  assert.equal(scene.debug.state, 'asleep');
  assert.equal(scene.node('mouse').style.display, 'none');
  scene.advance(goneAt + 60100);
  assert.equal(scene.debug.state, 'asleep');
  assert.equal(scene.debug.pushPhase, 'idle');
  assert.equal(scene.node('mouse').style.display, '');
});

test('the shared action switch inhibits scheduling and restores a stolen mouse when turned off', () => {
  const scene = harness({ push: true, pushEnabled: false });
  tapKey(scene);
  scene.advance(3400);
  assert.equal(scene.debug.mouseSnatched, false);
  assert.equal(scene.debug.pushPhase, 'idle');
  scene.pushModule.setEnabled(true);
  tapKey(scene);
  waitForPhase(scene, 'gone');
  scene.pushModule.setEnabled(false);
  scene.advance(scene.now + 1000);
  assert.equal(scene.debug.mouseSnatched, false);
  assert.equal(scene.node('mouse').style.display, '');
});

function assertLabel(scene, word) {
  const bar = scene.node('status-bar');
  assert.equal(bar.style.display, '');
  assert.equal(bar.querySelector('.sb-label').textContent, word);
  assert.equal(scene.debug.statusBar.label, word);
}

test('dog status bar labels track fatigue, destruction and the 60% rest threshold; cat labels stay intact', () => {
  const dog = harness({ fatigue: true });
  const cat = harness({ species: 'cat', fatigue: true });
  for (const scene of [dog, cat]) {
    for (let at = 0; at < 6000; at += 500) {
      scene.advance(at);
      tapKey(scene);
    }
    scene.advance(6000);
    assert.equal(scene.debug.statusBar.progress, 0.6);
  }
  assertLabel(dog, '想遛弯');
  assertLabel(cat, '烦躁');

  for (const scene of [dog, cat]) {
    for (let at = 6000; at < 10000; at += 500) {
      scene.advance(at);
      tapKey(scene);
    }
    scene.advance(10500);
    assert.equal(scene.debug.state, 'rage');
  }
  assertLabel(dog, '拆家中');
  assert.equal(cat.node('status-bar').style.display, 'none');
  for (const scene of [dog, cat]) {
    scene.advance(15995);
    assert.equal(scene.debug.state, 'strike');
    assert.equal(scene.debug.statusBar.progress, 0.599);
  }
  assertLabel(dog, '闹脾气');
  assertLabel(cat, '消气中');
  dog.advance(16005);
  assert.equal(dog.debug.statusBar.progress, 0.601);
  assertLabel(dog, '消气中');

  for (const species of ['dog', 'cat']) {
    const sleepy = harness({ species, fatigue: true, sleepSeconds: 2 });
    sleepy.advance(1500);
    assertLabel(sleepy, '困了');
  }
});

test('dog destruction leaves keyboard holes and tooth marks, then repair restores the keys', () => {
  const scene = harness({ fatigue: true, demo: { name: 'rage', loop: false } });
  scene.advance(200);
  assert.equal(scene.debug.dogHoles, 0);
  scene.advance(950);
  assert.equal(scene.debug.dogHoles, 2);
  scene.advance(2700);
  assert.equal(scene.debug.dogHoles, 4);
  assert.equal(scene.keyboard.codes().filter(scene.keyboard.isGone).length, 4);
  scene.advance(3400);
  assert.equal(scene.debug.state, 'strike');
  assert.equal(scene.debug.dogHoles, 4);
  assert.equal(scene.node('dog-toothmarks').style.display, '');
  scene.advance(8900);
  assert.equal(scene.debug.state, 'repair');
  const remaining = scene.debug.dogHoles;
  assert.ok(remaining > 0 && remaining < 4);
  scene.advance(10400);
  assert.equal(scene.debug.state, 'awake');
  assert.equal(scene.debug.dogHoles, 0);
  assert.equal(scene.keyboard.codes().filter(scene.keyboard.isGone).length, 0);
  assert.equal(scene.node('dog-toothmarks').style.display, '');
});

for (const keyboardStyle of ['compact', 'full']) {
  test(`the dog only reaches visible keys on the ${keyboardStyle} keyboard`, () => {
    const scene = harness({ keyboardStyle });
    const hiddenCode = keyboardStyle === 'compact' ? 'F12' : 'Fn';
    scene.pet.keyDown(hiddenCode);
    scene.advance(16);
    assert.ok(scene.debug.pressed.includes(hiddenCode));
    assert.equal(scene.debug.floaters.length, 0);
    assert.equal(scene.debug.paws.left, 'rest');
    assert.equal(scene.debug.paws.right, 'rest');
    scene.pet.keyUp(hiddenCode);

    const code = keyboardStyle === 'compact' ? 'KeyK' : 'F12';
    scene.pet.keyDown(code);
    scene.advance(400);
    assert.equal(scene.debug.paws.right, code);
    const target = scene.keyboard.center(code);
    assertNearCenter(scene.node('paw-l'), {
      x: target.x, y: target.y + scene.rig().paws.keyY * scene.keyboard.heightScale,
    }, 0.1);
  });

  test(`the dog removes and returns caps at the ${keyboardStyle} key centers`, () => {
    const scene = harness({ keyboardStyle, fatigue: true, demo: { name: 'rage', loop: false } });
    const codes = ['KeyB', 'KeyN', 'KeyM', 'KeyH'];
    scene.advance(16);
    assert.equal(scene.debug.state, 'rage');
    const startedAt = scene.now;
    for (const [i, code] of codes.entries()) {
      scene.advance(startedAt + 400 + 320 * i);
      const center = scene.keyboard.center(code);
      assertNearCenter(scene.node('dog-socket-' + code), center);
      assertNearCenter(scene.node('dog-cap-' + code), center);
      assert.equal(scene.keyboard.isGone(code), true);
    }

    scene.advance(startedAt + 1850);
    const marks = scene.node('dog-toothmarks');
    const { x, y, w } = scene.keyboard.bounds;
    assert.equal(marks.style.display, '');
    assert.deepEqual(translation(marks), { x: x + w - 16, y: y + 1 });
    const nextStyle = keyboardStyle === 'compact' ? 'full' : 'compact';
    scene.pet.setKeyboardStyle(nextStyle);
    scene.advance(startedAt + 3000);
    assert.equal(scene.keyboard.style, keyboardStyle);
    const repairAt = startedAt + 8000;
    scene.advance(repairAt);
    assert.equal(scene.debug.state, 'repair');
    for (const [i, code] of codes.entries()) {
      const arrival = repairAt + 320 + 345 * i + 290;
      scene.advance(arrival - 1);
      assertNearCenter(scene.node('dog-cap-' + code), scene.keyboard.center(code), 0.6);
      assert.equal(scene.keyboard.isGone(code), true);
      scene.advance(arrival);
      assert.equal(scene.keyboard.isGone(code), false);
    }
    scene.advance(startedAt + 10400);
    assert.equal(scene.keyboard.style, nextStyle);
    const newBounds = scene.keyboard.bounds;
    assert.deepEqual(translation(marks), { x: newBounds.x + newBounds.w - 16, y: newBounds.y + 1 });
    for (const code of codes) {
      assertNearCenter(scene.node('dog-socket-' + code), scene.keyboard.center(code));
    }
  });
}

test('both paws stay on stage in a frozen dog bite pose', () => {
  const scene = harness({ fatigue: true, demo: { name: 'rage', at: 405 } });
  scene.advance(32);
  for (const id of ['paw-l', 'paw-r']) {
    const transform = scene.node(id).getAttribute('transform');
    assert.match(transform, /scale\([\d.]+ [\d.]+\)/);
    assert.doesNotMatch(transform, /NaN|Infinity/);
  }
});
