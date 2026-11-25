import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createContext, Script } from 'node:vm';

const scripts = ['keyboard.js', 'cat.js', 'input-desktop.js'].map((filename) =>
  new Script(readFileSync(new URL(`../prototype/${filename}`, import.meta.url), 'utf8'), { filename }));

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  function schedule(callback, delay, interval = 0) {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay, interval });
    return id;
  }
  const clear = (id) => timers.delete(id);
  return {
    now: () => now,
    setTimeout: schedule,
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearTimeout: clear,
    clearInterval: clear,
    elapseWithoutCallbacks(ms) { now += ms; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = Math.max(now, timer.at);
        if (timer.interval) timer.at = now + timer.interval;
        else timers.delete(id);
        timer.callback();
        await flush();
      }
      now = end;
    },
  };
}

class FakeNode {
  contains(node) {
    return node === this || node.parent === this;
  }
}

function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  const captures = new Set();
  return Object.assign(new FakeNode(), {
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name),
    appendChild() {},
    remove() {},
    getScreenCTM: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    hasPointerCapture: (id) => captures.has(id),
    setPointerCapture: (id) => captures.add(id),
    releasePointerCapture: (id) => captures.delete(id),
  });
}

const unreadable = () => ({ keys: null, buttons: [] });
const cursorAt = (x) => ({ x, y: 10, gx: x, gy: 10 });
const pending = () => new Promise(() => {});
const macKeyCodes = { F12: 111, KeyK: 40 };

async function setup({ held = unreadable, cursor = () => null, clickThrough = false } = {}) {
  const clock = fakeClock();
  const frames = [];
  const errors = [];
  const listeners = new Map();
  const domListeners = new Map();
  const elements = new Map();
  const moves = [];
  const positions = [];
  const ignoreCalls = [];
  const mouseButtons = [];
  const gestures = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  }
  const scene = element('scene');
  const head = element('cat-head');
  const body = element('cat-body');
  head.parent = body.parent = scene;
  const window = createContext({
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    performance: { now: clock.now },
    requestAnimationFrame: (callback) => frames.push(callback),
    console: { error: (...args) => errors.push(args) },
    navigator: { userAgent: 'Macintosh' },
    Node: FakeNode,
    document: {
      getElementById: element, createElementNS: fakeElement,
      elementFromPoint: (x) => x === 10 ? head : x === 14 ? body : null,
    },
    innerWidth: 800, innerHeight: 600,
    addEventListener: (name, listener) => domListeners.set(name, listener),
    removeEventListener() {},
    SillyArt: { arm() {}, cheek() {} },
    SillyCoats: { current: () => ({}) },
    SillyUpdater: { subscribe: () => () => {} },
    __TAURI__: {
      core: {
        async invoke(command) {
          switch (command) {
            case 'cursor_local': return cursor(clock.now());
            case 'held_input_state': return held(clock.now());
            case 'input_status': return { needs_permission: false };
            case 'position_locked': return false;
            case 'click_through_status': return { enabled: clickThrough, available: true };
            default: assert.fail(`Unexpected IPC: ${command}`);
          }
        },
      },
      event: {
        async listen(name, listener) {
          listeners.set(name, listener);
          return () => listeners.delete(name);
        },
      },
      window: {
        getCurrentWindow: () => ({
          async setIgnoreCursorEvents(v) { ignoreCalls.push(v); },
          async startDragging() { gestures.push('dragStart'); },
        }),
      },
    },
  });
  window.window = window;
  for (const script of scripts) script.runInContext(window);

  const keyboard = window.SillyKeyboard.build(element('keyboard'));
  const cat = window.SillyCat.createCat({ keyboard });
  const desktop = window.SillyDesktopInput.create({
    ...cat,
    pointerMove(...args) { moves.push(args); cat.pointerMove(...args); },
    pointerAt(...args) { positions.push(args); cat.pointerAt(...args); },
    pointerDown(button) { mouseButtons.push(['down', button]); cat.pointerDown(button); },
    pointerUp(button) { mouseButtons.push(['up', button]); cat.pointerUp(button); },
    petStart(...args) { gestures.push('petStart'); cat.petStart(...args); },
    petEnd() { gestures.push('petEnd'); cat.petEnd(); },
  }, { sceneEl: scene, headEl: head });
  await flush();

  function emit(name, payload) { listeners.get(`silly:${name}`)({ payload }); }
  return {
    window, clock, cat, desktop, keyboard, element, errors, moves, positions, ignoreCalls, mouseButtons, gestures,
    clickThrough: (enabled) => emit('click-through', { enabled, available: true }),
    pointerDown: (target) => domListeners.get('pointerdown')({
      target, button: 0, pointerId: 1, clientX: 10, clientY: 10, preventDefault() {},
    }),
    key: (code, down) => emit('key', { kc: macKeyCodes[code], down }),
    button: (button, down) => emit('button', { button, down }),
    caps: () => emit('key', { kc: 57 }),
    frame() {
      assert.equal(frames.length, 1, 'expected exactly one scheduled frame');
      frames.shift()(clock.now());
    },
    assertF12Held() {
      assert.ok(desktop.debug.held.includes('F12'));
      assert.ok(cat.debug.pressed.includes('F12'));
      assert.equal(cat.debug.paws.right, 'F12');
    },
    assertF12Released() {
      assert.ok(!desktop.debug.held.includes('F12'));
      assert.ok(!cat.debug.pressed.includes('F12'));
      assert.equal(cat.debug.paws.right, 'rest');
    },
  };
}

test('启动时恢复鼠标穿透，猫身上的点击和指针移动仍交给猫', async () => {
  const app = await setup({ clickThrough: true, cursor: (now) => cursorAt(now <= 33 ? 10 : 14) });
  await app.clock.advance(33);
  assert.equal(app.desktop.debug.over, true);
  assert.deepEqual(app.ignoreCalls, [true]);
  app.button(0, true);
  app.button(0, false);
  assert.deepEqual(app.mouseButtons, [['down', 0], ['up', 0]]);
  await app.clock.advance(33);
  assert.deepEqual(app.moves, [[4, 0]]);
  assert.deepEqual(app.positions, [[14, 10]]);
  assert.deepEqual(app.ignoreCalls, [true]);

  app.clickThrough(false);
  assert.equal(app.ignoreCalls.at(-1), false);
  app.button(0, true);
  app.button(0, false);
  assert.deepEqual(app.mouseButtons, [['down', 0], ['up', 0]]);
});

test('摸头时打开鼠标穿透会立即结束摸头并释放捕获', async () => {
  const app = await setup({ cursor: () => cursorAt(10) });
  await app.clock.advance(33);
  const head = app.element('cat-head');
  app.pointerDown(head);
  assert.deepEqual(app.gestures, ['petStart']);
  assert.equal(head.hasPointerCapture(1), true);
  app.clickThrough(true);
  assert.deepEqual(app.gestures, ['petStart', 'petEnd']);
  assert.equal(head.hasPointerCapture(1), false);
  assert.equal(app.ignoreCalls.at(-1), true);
  app.button(0, true);
  assert.deepEqual(app.mouseButtons, [['down', 0]]);
});

test('鼠标穿透开启时按下身体不启动拖动，关闭后可以拖动', async () => {
  const app = await setup({ clickThrough: true, cursor: () => cursorAt(14) });
  await app.clock.advance(33);
  const body = app.element('cat-body');
  app.pointerDown(body);
  assert.deepEqual(app.gestures, []);
  app.clickThrough(false);
  app.pointerDown(body);
  assert.deepEqual(app.gestures, ['dragStart']);
});

test('每秒移动鼠标时，漏掉抬起的 F12 仍会在连续不可读 5 秒后释放', async () => {
  const app = await setup({ cursor: (now) => cursorAt(Math.floor(now / 1000)) });
  assert.equal(app.keyboard.has('F12'), false); // F12 使用键盘边缘落点
  app.key('F12', true);
  app.frame();
  await app.clock.advance(5999);
  app.assertF12Held();
  await app.clock.advance(121); // 保留猫原有的 120 毫秒松爪动画
  app.assertF12Released();
  assert.equal(app.moves.length, 6);
});

test('同一只爪持续打别的键时，漏掉抬起的 F12 仍按时释放', async () => {
  const app = await setup();
  app.key('F12', true);
  for (let i = 0; i < 6; i++) {
    await app.clock.advance(950);
    app.key('KeyK', true);
    assert.equal(app.cat.debug.paws.right, 'KeyK');
    await app.clock.advance(50);
    app.key('KeyK', false);
    if (i < 5) app.assertF12Held();
  }
  await app.clock.advance(120);
  app.assertF12Released();
});

test('系统持续确认真实长按，超过兜底时间仍保持 F12', async () => {
  const app = await setup({ held: () => ({ keys: ['F12'], buttons: [] }) });
  app.key('F12', true);
  await app.clock.advance(12_000);
  app.assertF12Held();
});

test('一次可读的按住结果会清零该次按下的不可读计时', async () => {
  const app = await setup({ held: (now) => now === 4000 ? { keys: ['F12'] } : unreadable() });
  app.key('F12', true);
  await app.clock.advance(9999);
  app.assertF12Held();
  await app.clock.advance(121);
  app.assertF12Released();
});

test('旧查询返回已松开时，保留同一个键的新一轮按下', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let queries = 0;
  const app = await setup({ held: () => ++queries === 1 ? promise : { keys: ['F12'] } });
  app.key('F12', true);
  await app.clock.advance(1100);
  assert.equal(queries, 1);
  app.key('F12', false);
  app.key('F12', true);
  resolve({ keys: [] });
  await flush();
  app.assertF12Held();
  await app.clock.advance(3000);
  assert.ok(queries > 1);
  app.assertF12Held();
});

test('系统报已松开时立即纠偏', async () => {
  const app = await setup({ held: () => ({ keys: [], buttons: [] }) });
  app.key('F12', true);
  app.button(0, true);
  await app.clock.advance(999);
  app.assertF12Held();
  assert.ok(app.element('mouse-btn-l').classList.contains('down'));
  await app.clock.advance(1);
  assert.equal(app.cat.debug.pressed.length, 0);
  assert.ok(!app.element('mouse-btn-l').classList.contains('down'));
  await app.clock.advance(120);
  app.assertF12Released();
});

test('IPC 拒绝时，先后按下的键盘键和鼠标键各自按时释放', async () => {
  const app = await setup({ held() { throw new Error('input state unavailable'); } });
  app.key('F12', true);
  await app.clock.advance(2000);
  app.button(0, true);
  await app.clock.advance(4120);
  app.assertF12Released();
  assert.ok(app.element('mouse-btn-l').classList.contains('down'));
  await app.clock.advance(1880);
  assert.ok(!app.element('mouse-btn-l').classList.contains('down'));
});

test('键盘状态不可读时，仍按可读的鼠标状态纠偏', async () => {
  const app = await setup();
  app.key('F12', true);
  app.button(0, true);
  await app.clock.advance(1000);
  app.assertF12Held();
  assert.ok(!app.element('mouse-btn-l').classList.contains('down'));
});

test('held_input_state 连续挂起也会超时、继续查询并释放 F12', async () => {
  const first = Promise.withResolvers();
  let queries = 0;
  const app = await setup({ held: () => ++queries === 1 ? first.promise : pending() });
  app.key('F12', true);
  await app.clock.advance(4100);
  assert.ok(queries > 1);
  first.resolve({ keys: [] });
  await flush();
  app.assertF12Held();
  await app.clock.advance(5100);
  app.assertF12Released();
});

test('IPC 已超过期限时，即使比超时回调先执行也会丢弃', async () => {
  const late = Promise.withResolvers();
  const app = await setup({ held: () => late.promise });
  app.key('F12', true);
  await app.clock.advance(1100);
  app.clock.elapseWithoutCallbacks(1901);
  late.resolve({ keys: [] });
  await flush();
  app.assertF12Held();
});

test('cursor_local 挂起时键态纠偏独立运行', async () => {
  let queries = 0;
  const app = await setup({ cursor: () => { queries++; return pending(); } });
  app.key('F12', true);
  await app.clock.advance(6120);
  app.assertF12Released();
  assert.ok(queries > 1);
});

test('已超时的指针结果不能移动鼠标或改写下一次的坐标基准', async () => {
  const late = Promise.withResolvers();
  let queries = 0;
  const app = await setup({ cursor() {
    queries++;
    if (queries === 2) return late.promise;
    return cursorAt(queries < 4 ? 10 : 14);
  } });
  await app.clock.advance(2100);
  assert.equal(queries, 3);
  late.resolve(cursorAt(100));
  await flush();
  assert.deepEqual(app.moves, []);
  assert.deepEqual(app.positions, []);
  await app.clock.advance(20);
  assert.deepEqual(app.moves, [[4, 0]]);
  assert.deepEqual(app.positions, [[14, 10]]);
});

test('macOS Caps Lock 仍在 120 毫秒释放', async () => {
  const app = await setup();
  app.caps();
  await app.clock.advance(119);
  assert.ok(app.cat.debug.pressed.includes('CapsLock'));
  await app.clock.advance(1);
  assert.ok(!app.cat.debug.pressed.includes('CapsLock'));
});

test('绘制抛错后仍逐帧调度，相同错误只记录一次，恢复后能画完整一帧', async () => {
  const app = await setup();
  let fail = true;
  app.window.SillyArt.arm = () => { if (fail) throw new Error('arm draw failed'); };
  app.frame();
  await app.clock.advance(16);
  app.frame();
  assert.equal(app.errors.length, 1);
  assert.match(String(app.errors[0][1]), /arm draw failed/);
  assert.equal(app.element('cat-body').getAttribute('transform'), undefined);
  fail = false;
  await app.clock.advance(16);
  app.frame();
  assert.match(app.element('cat-body').getAttribute('transform'), /^translate/);
  await app.clock.advance(16);
  app.frame();
  assert.equal(app.errors.length, 1);
});
