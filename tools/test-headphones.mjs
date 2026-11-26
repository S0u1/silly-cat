import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createContext, Script } from 'node:vm';

const read = (file) => readFileSync(new URL(`../prototype/${file}`, import.meta.url), 'utf8');
const scripts = new Map(['species.js', 'species-cat.js', 'species-dog.js', 'headphones.js', 'coats.js', 'art.js', 'settings.js'].map((file) =>
  [file, new Script(read(file), { filename: file })]));

function load(files, globals = {}) {
  const sandbox = createContext(globals);
  sandbox.window = sandbox;
  for (const file of ['species.js', 'species-cat.js', 'species-dog.js', ...files]) scripts.get(file).runInContext(sandbox);
  return sandbox;
}

const { SillyHeadphones: HP } = load(['headphones.js']);
const active = { supported: true, active: true, via: 'test' };
const silent = { ...active, active: false };

test('continuous playback must reach three seconds, with silence restarting the clock', () => {
  const gate = HP.createListenGate();
  for (const [playing, at] of [[true, 0], [true, 1000], [false, 1900], [true, 2000], [true, 3500], [true, 4999]]) {
    assert.equal(gate(playing, at), false);
  }
  assert.equal(gate(true, 5000), true);
});

test('continuous silence must reach eight seconds, with playback restarting the clock', () => {
  const gate = HP.createListenGate();
  assert.equal(gate(true, 0), false);
  assert.equal(gate(true, 1500), false);
  assert.equal(gate(true, 3000), true);
  for (const at of [4000, 6000, 8000, 10000]) assert.equal(gate(false, at), true);
  assert.equal(gate(true, 11000), true);
  for (const at of [12000, 14000, 16000, 18000, 19999]) assert.equal(gate(false, at), true);
  assert.equal(gate(false, 20000), false);
});

test('gaps over 2.5 seconds break playback and can count toward taking off headphones', () => {
  const gate = HP.createListenGate();
  assert.equal(gate(true, 0), false);
  assert.equal(gate(true, 2500), false);
  assert.equal(gate(true, 3000), true);
  assert.equal(gate(true, 10999), true);
  assert.equal(gate(true, 19000), false);
  assert.equal(gate(true, 21000), false);
  assert.equal(gate(true, 22000), true);

  const interrupted = HP.createListenGate();
  assert.equal(interrupted(true, 0), false);
  assert.equal(interrupted(true, 1000), false);
  assert.equal(interrupted(true, 3600), false);
  assert.equal(interrupted(true, 5600), false);
  assert.equal(interrupted(true, 6600), true);
});

test('alternating samples neither put on idle headphones nor remove worn headphones', () => {
  const gate = HP.createListenGate();
  for (let i = 0; i < 20; i++) assert.equal(gate(i % 2 === 0, i * 1000), false);
  for (const at of [20000, 21000, 22000]) assert.equal(gate(true, at), false);
  assert.equal(gate(true, 23000), true);
  for (let i = 24; i < 48; i++) assert.equal(gate(i % 2 === 1, i * 1000), true);
});

function pollHarness(respond, desktop = true) {
  let time = 0, key = 0;
  const scheduled = new Map(), calls = [], samples = [];
  const { SillyHeadphones } = load(['headphones.js'], {
    performance: { now: () => time },
    setTimeout(callback, delay) {
      const id = ++key;
      scheduled.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
  });
  const invoke = desktop ? (command) => {
    assert.equal(command, 'media_activity');
    calls.push(time);
    return respond(time);
  } : null;
  const poller = SillyHeadphones.createMediaPoller(invoke, (on, at) => samples.push([on, at]));
  return {
    ...poller, calls, samples,
    async advance(end) {
      await flush();
      for (;;) {
        const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, { at, callback }] = next;
        time = at;
        scheduled.delete(id);
        callback();
        await flush();
      }
      time = end;
    },
  };
}

test('polls only when enabled on desktop, about once per second, and stops immediately when disabled', async () => {
  const web = pollHarness(() => assert.fail('Browser must not invoke IPC'), false);
  web.setEnabled(true);
  await web.advance(10000);
  assert.deepEqual(web.calls, []);

  const poll = pollHarness(() => active);
  await poll.advance(5000);
  assert.deepEqual(poll.calls, []);
  poll.setEnabled(true);
  poll.setEnabled(true);
  await poll.advance(8000);
  assert.deepEqual(poll.calls, [5000, 6000, 7000, 8000]);
  assert.deepEqual(poll.samples.at(-1), [true, 8000]);
  poll.setEnabled(false);
  assert.deepEqual(poll.samples.at(-1), [false, 8000]);
  await poll.advance(20000);
  assert.deepEqual(poll.calls, [5000, 6000, 7000, 8000]);
});

test('rejection, synchronous throw and timeout become inactive samples, with late replies ignored', async () => {
  let finishLate;
  const poll = pollHarness((at) => {
    if (at <= 3000) return active;
    if (at === 4000) return Promise.reject(new Error('IPC failed'));
    if (at === 5000) throw new Error('IPC threw');
    if (at === 6000) return new Promise((resolve) => { finishLate = resolve; });
    return silent;
  });
  poll.setEnabled(true);
  await poll.advance(11999);
  assert.deepEqual(poll.calls.slice(4, 8), [4000, 5000, 6000, 8000]);
  assert.deepEqual(poll.samples.at(-1), [true, 11000]);
  finishLate(active);
  await poll.advance(12000);
  assert.deepEqual(poll.samples.at(-1), [false, 12000]);
  assert.equal(poll.samples.filter(([, at]) => at === 8000).length, 2); // timeout + next successful sample
});

test('unsupported immediately takes off headphones and stops polling for the page session', async () => {
  const poll = pollHarness((at) => at < 4000 ? active : { ...active, supported: false });
  poll.setEnabled(true);
  await poll.advance(10000);
  assert.deepEqual(poll.calls, [0, 1000, 2000, 3000, 4000]);
  assert.deepEqual(poll.samples.slice(-2), [[true, 3000], [false, 4000]]);
  poll.setEnabled(false);
  poll.setEnabled(true);
  await poll.advance(20000);
  assert.equal(poll.calls.length, 5);
});

test('disabling and re-enabling discards a pending reply from the old poll', async () => {
  let reply;
  const poll = pollHarness((at) => at === 0 ? new Promise((resolve) => { reply = resolve; }) : active);
  poll.setEnabled(true);
  await poll.advance(100);
  poll.setEnabled(false);
  poll.setEnabled(true);
  reply({ ...active, supported: false });
  await poll.advance(3100);
  assert.deepEqual(poll.calls, [0, 100, 1100, 2100, 3100]);
  assert.deepEqual(poll.samples.at(-1), [true, 3100]);
});

test('old settings default to off and saved booleans survive sanitization', () => {
  const { SillySettings: settings } = load(['settings.js']);
  assert.equal(settings.sanitize({}).headphones, false);
  assert.equal(settings.sanitize({ headphones: 'true' }).headphones, false);
  assert.equal(settings.sanitize({ headphones: true }).headphones, true);
});

test('saved headphone colors survive sanitization and missing or invalid values use strawberry', () => {
  const { SillySettings: settings } = load(['settings.js']);
  for (const headphoneColor of ['strawberry', 'mint', 'latte', 'sky']) {
    assert.equal(settings.sanitize({ headphoneColor }).headphoneColor, headphoneColor);
  }
  for (const headphoneColor of ['pink', 'constructor', '__proto__', '', 3, null]) {
    assert.equal(settings.sanitize({ headphoneColor }).headphoneColor, 'strawberry');
  }
  assert.equal(settings.sanitize({}).headphoneColor, 'strawberry');
});

test('all ten cat coat outlines give both cups eye clearance and a centered band in each style', () => {
  const d = read('index.html').match(/id="clip-head-path" d="([^"]+)"/)[1];
  const elements = new Map();
  function fakeElement() {
    const attrs = new Map([['d', d]]);
    return {
      dataset: {}, style: {}, childNodes: [],
      getAttribute: (key) => attrs.get(key),
      setAttribute: (key, value) => attrs.set(key, value),
      removeAttribute: (key) => attrs.delete(key),
      append() {},
      insertBefore() {},
      replaceWith() {},
      insertAdjacentHTML() {},
    };
  }
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        ...fakeElement(),
        firstElementChild: id === 'clip-back-head' ? element('back-path') : null,
      });
    }
    return elements.get(id);
  }
  const { SillyCoats } = load(['art.js', 'coats.js'], {
    document: {
      documentElement: element('html'),
      getElementById: element,
      createElementNS: fakeElement,
      querySelector: element,
      querySelectorAll: () => [],
    },
  });
  const cats = SillyCoats.list().filter(({ species }) => species === 'cat');
  assert.equal(cats.length, 10);
  for (const style of ['fur', 'line']) {
    for (const { id } of cats) {
      const coat = SillyCoats.setArtStyle(style, id);
      const label = `${id}/${style}`;
      const path = element('clip-head-path').getAttribute('d');
      assert.equal(path, coat.art?.headPath ?? d, label);
      const bounds = HP.headBounds(path);
      const { k, w, top, left, right, rx, ry } = HP.geometry(bounds);
      // 侧面耳罩整条在头轮廓外：内缘离轮廓 2k，耳垫最多伸进轮廓 4k，都离眼睛圆 6 以上。
      assert.ok(345 - 29 - (bounds.x0 + 4 * k + 2) >= 6, label);
      assert.ok(bounds.x1 - 4 * k - 2 - (455 + 29) >= 6, label);
      assert.ok(top >= bounds.y0 && top <= bounds.y0 + 0.06 * w, label);
      assert.ok(Math.abs(left + rx - (bounds.x0 - 2 * k)) < 1e-9, label);
      assert.ok(Math.abs(right - rx - (bounds.x1 + 2 * k)) < 1e-9, label);
      assert.ok(Math.abs(rx - 13.5 * k) < 1e-9, label);
      assert.ok(Math.abs(ry - 35 * k) < 1e-9, label);
    }
  }
});

test('both dog cups clear the eyes and the band is centered over the muzzle', () => {
  const dog = load([]).SillySpecies.get('dog');
  const { eyes, head } = dog.rig;
  const bounds = HP.headBounds(head.path(0));
  const cups = HP.geometry(bounds, dog.headphones.fit);
  assert.ok(cups.left + cups.rx < eyes.centers.L.x - eyes.radius);
  assert.ok(cups.right - cups.rx > eyes.centers.R.x + eyes.radius);
  assert.equal(cups.cx, (eyes.centers.L.x + eyes.centers.R.x) / 2);
});
