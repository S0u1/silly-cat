import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createContext, Script } from 'node:vm';

const read = (file) => readFileSync(new URL(`../prototype/${file}`, import.meta.url), 'utf8');
const html = read('index.html');
const scripts = ['species.js', 'species-cat.js', 'species-dog.js', 'coats.js', 'settings.js']
  .map((file) => new Script(read(file), { filename: file }));
const entry = new Script([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1], { filename: 'index.html' });

function load({ search = '', settings } = {}) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const attributes = new Map(), events = new Map();
      nodes.set(id, {
        dataset: {}, style: {}, attributes, events,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
        addEventListener: (name, handler) => events.set(name, handler),
        insertAdjacentHTML() {}, add() {}, blur() {},
      });
    }
    return nodes.get(id);
  }
  const document = {
    title: html.match(/<title>([^<]+)<\/title>/)[1],
    documentElement: node('html'),
    getElementById: node,
    querySelector: node,
    querySelectorAll: () => [],
  };
  node('scene').setAttribute('aria-label', html.match(/<svg id="scene"[^>]+aria-label="([^"]+)"/)[1]);
  Object.assign(document.documentElement.dataset, { cat: 'cow', artStyle: 'fur' });
  const calls = [];
  let onSettings;
  const desktop = settings !== undefined;
  const noOpModule = new Proxy({}, { get: () => () => {} });
  const sandbox = createContext({
    document, location: { search }, URLSearchParams, Option: function () {},
    setInterval() {},
    SillyArt: { apply() {} },
    SillyKeyboard: { build() {} },
    SillyCat: {
      createCat({ modules }) {
        for (const use of modules) use({});
        return noOpModule;
      },
    },
    SillyInput: { createBrowserInput() {} },
    SillyDesktopInput: {
      isDesktop: () => desktop,
      create: () => ({}),
    },
    __TAURI__: desktop ? {
      core: {
        async invoke(command, args) {
          if (command === 'load_settings') return settings;
          assert.equal(command, 'set_pet_title');
          calls.push(args.title);
        },
      },
      event: { async listen(name, handler) { assert.equal(name, 'silly:settings'); onSettings = handler; } },
    } : undefined,
  });
  for (const name of ['Sleep', 'Fatigue', 'Push', 'StatusBar', 'Headphones']) {
    sandbox['Silly' + name] = { create: () => noOpModule };
  }
  sandbox.window = sandbox;
  for (const script of scripts) script.runInContext(sandbox);
  entry.runInContext(sandbox);
  return {
    calls,
    assertPet(name, style) {
      assert.equal(document.title, '捣蛋' + name);
      assert.equal(node('scene').attributes.get('aria-label'), '坐在键盘后面的' + name);
      assert.equal(document.documentElement.dataset.artStyle, style);
    },
    select(id) {
      node('cat-select').value = id;
      node('cat-select').events.get('change')();
    },
    save(payload) { onSettings({ payload }); },
  };
}

test('browser title and scene label follow query selection and subsequent pet changes', () => {
  const scene = load({ search: '?cat=tianyuan&style=line' });
  scene.assertPet('大黄', 'fur');
  scene.select('corgi');
  scene.assertPet('柯基', 'fur');
  scene.select('collie');
  scene.assertPet('边牧', 'fur');
  scene.select('orange');
  scene.assertPet('橘猫', 'line');
  load({ search: '?cat=unknown' }).assertPet('奶牛猫', 'fur');
});

test('desktop title requests follow saved settings, live switching and fallback', async () => {
  const scene = load({ settings: { cat: 'collie', artStyle: 'line' } });
  await flush();
  scene.assertPet('边牧', 'fur');
  scene.save({ cat: 'orange', artStyle: 'line' });
  scene.assertPet('橘猫', 'line');
  scene.save({ cat: 'orange', artStyle: 'fur' });
  scene.assertPet('橘猫', 'fur');
  scene.save({ cat: 'unknown' });
  scene.assertPet('奶牛猫', 'fur');
  assert.deepEqual(scene.calls, ['捣蛋边牧', '捣蛋橘猫', '捣蛋奶牛猫']);

  const unconfigured = load({ settings: null });
  await flush();
  unconfigured.assertPet('奶牛猫', 'fur');
  assert.deepEqual(unconfigured.calls, ['捣蛋奶牛猫']);
});

test('a new desktop selection takes precedence over the pending startup settings', async () => {
  let finishLoading;
  const settings = new Promise((resolve) => { finishLoading = resolve; });
  const scene = load({ settings });
  await flush();
  scene.save({ cat: 'corgi' });
  finishLoading({ cat: 'orange' });
  await flush();
  scene.assertPet('柯基', 'fur');
  assert.deepEqual(scene.calls, ['捣蛋柯基']);
});
