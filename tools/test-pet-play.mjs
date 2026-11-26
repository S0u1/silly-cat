import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, Script } from 'node:vm';

const scripts = ['settings.js', 'head-follow.js', 'swat.js', 'grump.js'].map(filename =>
  new Script(readFileSync(new URL(`../prototype/${filename}`, import.meta.url), 'utf8'), { filename }));

function element() {
  return { setAttribute() {}, style: {}, appendChild() {}, firstElementChild: { style: {} }, lastElementChild: { style: {} } };
}

function fixture() {
  let now = 0, phase = null;
  const environment = createContext({
    performance: { now: () => now },
    document: { createElementNS: element, getElementById: element },
  });
  environment.window = environment;
  for (const script of scripts) script.runInContext(environment);
  const STATES = { AWAKE: 'awake', ASLEEP: 'asleep', DROWSY: 'drowsy', PETTED: 'petted' };
  const S = {
    state: STATES.AWAKE, sleepSince: 0, pet: null, shakeStart: -Infinity, lastKeyAt: -Infinity,
    pressed: new Set(), mouseButtons: new Set(), pointer: null,
  };
  const fatigue = { statusInfo: () => ({ phase }) };
  const shoulders = { L: { x: 446, y: 304 }, R: { x: 354, y: 304 } };
  const kb = { codes: () => ['KeyA', 'KeyK'], bounds: { y: 374, h: 206 } };
  const keyPoint = code => code === 'KeyA' ? { x: 604, y: 500 } : { x: 196, y: 500 };
  const restPoint = side => ({ x: shoulders[side].x, y: 425 });
  const paws = { L: { ...restPoint('L'), side: 'L' }, R: { ...restPoint('R'), side: 'R' } };
  const ctx = {
    S, STATES, el: { head: element() }, shoulders, kb, keyPoint, restPoint, paws,
    choosePaw: code => code === 'KeyA' ? paws.L : paws.R,
    reducedMotion: () => false, pointerInScene: () => S.pointer,
    clamp: (v, min, max) => Math.min(max, Math.max(v, min)),
  };
  const grump = environment.SillyGrump.create(ctx, { fatigue });

  return {
    S, STATES, ctx, grump, settings: environment.SillySettings,
    makeSwat: opts => environment.SillySwat.create(ctx, opts),
    setPhase(value) { phase = value; },
    tick(t) { now = t; grump.afterState(t); },
    wake(t, start = t) {
      now = t;
      S.shakeStart = start;
      grump.onWake(t);
      S.state = STATES.AWAKE;
    },
  };
}

test('drowsy and short sleep do not cause grump; qualifying sleep waits for a delayed shake', () => {
  const { S, STATES, grump, wake, tick } = fixture();
  S.state = STATES.DROWSY;
  wake(6000);
  tick(6420);
  assert.equal(grump.anger(), 0);

  S.state = STATES.ASLEEP;
  S.sleepSince = 7000;
  wake(11999);
  tick(12419);
  assert.equal(grump.anger(), 0);

  S.state = STATES.ASLEEP;
  S.sleepSince = 13000;
  wake(18000, 18250);
  tick(18669);
  assert.equal(grump.anger(), 0);
  tick(18670);
  assert.equal(grump.anger(), 1);
});

test('natural cooling takes one minute and pauses through rage, strike and repair', () => {
  const { S, STATES, grump, setPhase, wake, tick } = fixture();
  S.state = STATES.ASLEEP;
  wake(5000);
  tick(5420);
  tick(20420);
  assert.equal(grump.anger(), 0.75);
  for (const [i, phase] of ['rage', 'strike', 'repair'].entries()) {
    setPhase(phase);
    tick(20420 + i * 10000);
    assert.equal(grump.status(20420), null);
  }
  setPhase(null);
  tick(50420);
  assert.equal(grump.anger(), 0.75);
  tick(95420);
  assert.equal(grump.status(95420).kind, 'grumpCalm');
  assert.equal(grump.status(97420), null);
});

test('moving petting opens purring after about 2.8 seconds and clears anger in four seconds', () => {
  const { S, STATES, grump, wake, tick } = fixture();
  S.state = STATES.ASLEEP;
  wake(5000);
  tick(5420);
  S.pet = { movedAt: 5420 };
  for (let t = 5520; t <= 8120; t += 100) {
    tick(t);
    S.pet.movedAt = t;
  }
  assert.equal(grump.canPurr(), false);
  tick(8220);
  S.pet.movedAt = 8220;
  tick(8320);
  assert.equal(grump.canPurr(), true);
  for (let t = 8420; t <= 9420; t += 100) {
    S.pet.movedAt = t - 100;
    tick(t);
  }
  assert.equal(grump.anger(), 0);
  assert.equal(grump.status(9420).kind, 'grumpCalm');

  const still = fixture();
  still.S.state = still.STATES.ASLEEP;
  still.wake(5000);
  still.tick(5420);
  still.S.pet = { movedAt: -Infinity };
  still.tick(9420);
  assert.ok(Math.abs(still.grump.anger() - 2 / 3) < 1e-8);
  assert.equal(still.grump.canPurr(), false);
});

function swatFixture(opts) {
  const fixtureState = fixture();
  const swat = fixtureState.makeSwat(opts);
  function frame(t, point) {
    fixtureState.tick(t);
    if (point) fixtureState.S.pointer = { ...point, at: t };
    swat.afterState(t);
  }
  const side = (t) => swat.isActing(t) ? swat.debugProps.swat().side : null;
  return { ...fixtureState, swat, frame, side };
}

test('swat ignores stationary, stale, low, held and freshly typed input', () => {
  const mouse = { x: 590, y: 340 };
  for (const scenario of ['stationary', 'stale', 'below keyboard', 'button', 'drag', 'key', 'recent key', 'asleep', 'drowsy', 'push', 'reduced motion']) {
    const f = swatFixture({ pointerHeld: () => scenario === 'drag', isPushing: () => scenario === 'push' });
    if (scenario === 'key') f.S.pressed.add('KeyA');
    if (scenario === 'recent key') f.S.lastKeyAt = 100;
    if (scenario === 'button') f.S.mouseButtons.add(0);
    if (scenario === 'asleep') f.S.state = f.STATES.ASLEEP;
    if (scenario === 'drowsy') f.S.state = f.STATES.DROWSY;
    // 模块构建时读入 reducedMotion；用同一上下文创建其减少动画版本。
    if (scenario === 'reduced motion') {
      f.ctx.reducedMotion = () => true;
      const swat = f.makeSwat();
      f.S.pointer = { ...mouse, at: 0 }; swat.afterState(0);
      f.S.pointer = { x: 620, y: 340, at: 100 }; swat.afterState(100);
      assert.equal(swat.isActing(100), false);
      continue;
    }
    f.frame(0, mouse);
    f.frame(scenario === 'stale' ? 400 : 200, {
      x: scenario === 'stationary' ? mouse.x : 620,
      y: scenario === 'below keyboard' ? 610 : mouse.y,
    });
    assert.equal(f.side(400), null, scenario);
  }
});

test('swat caps a fleeing target along its shoulder ray and typing releases the forced paw', () => {
  const { ctx, swat, frame, side } = swatFixture();
  frame(0, { x: 580, y: 350 });
  frame(100, { x: 595, y: 350 });
  assert.equal(side(100), 'L');
  frame(320, { x: 790, y: 560 });
  const target = swat.forcedPawTarget(ctx.paws.L, 320);
  const dx = target.x - 446, dy = target.y - 304;
  assert.ok(Math.abs(Math.hypot(dx, dy) - 201.5) < 0.5); // 爪子最远 = 最远键距 × 0.8
  assert.ok(Math.abs(dx / dy - (790 - 446) / (560 - 304)) < 1e-8);
  swat.afterKeyDown('KeyA', 321);
  assert.equal(swat.forcedPawTarget(ctx.paws.L, 321), null);
});

test('continuous movement can chain one opposite paw only, with a longer second cooldown', () => {
  const { frame, side } = swatFixture();
  const at = (x) => ({ x, y: 340 });
  frame(0, at(540));
  frame(100, at(560));
  assert.equal(side(100), 'L');
  frame(700, at(540));
  frame(2000, at(560));
  frame(2120, at(540));
  assert.equal(side(2120), null, 'first cooldown still running');
  frame(2200, at(560));
  assert.equal(side(2200), 'R');
  frame(2800, at(540));
  frame(5520, at(560));
  frame(5720, at(540));
  assert.equal(side(5720), null, 'second cooldown still running');
  frame(5800, at(560));
  assert.equal(side(5800), 'L');
});

test('older settings use safe defaults and purr volume is clamped', () => {
  const { settings } = fixture();
  const old = settings.sanitize({ eyesFollow: false });
  assert.deepEqual([old.eyesFollow, old.swat, old.grump, old.purr, old.purrVolume], [false, true, true, true, 60]);
  assert.equal(settings.sanitize({ purrVolume: 140 }).purrVolume, 100);
  assert.equal(settings.sanitize({ purrVolume: -1 }).purrVolume, 0);
  assert.equal(settings.sanitize({ purrVolume: '80' }).purrVolume, 60);
});
