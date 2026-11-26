import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

const read = (file) => readFileSync(new URL(`../../prototype/${file}`, import.meta.url), 'utf8');
export const scene = read('index.html');
const sceneScripts = new Set(['species.js', 'species-cat.js', 'species-dog.js', 'keyboard.js',
  'cat.js', 'dog-mischief.js', 'fatigue.js', 'dog-snatch.js', 'push.js', 'statusbar.js']);
const scripts = [...scene.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(([, file]) => file)
  .filter((file) => sceneScripts.has(file))
  .map((file) => new Script(read(file), { filename: file }));

export function harness({ species = 'dog', demo = null, sleepSeconds = 60,
  random = 0.1, push = false, pushEnabled = true, fatigue = false,
  workSeconds = 10, restSeconds = 5, mouseSide = 'right', reducedMotion = false } = {}) {
  let now = 0, nextFrame;
  const nodes = new Map();
  function registerIds(source) {
    for (const [, id] of source.matchAll(/\bid="([\w-]+)"/g)) nodes.set(id, createElement());
  }
  function createElement() {
    const attributes = new Map(), classes = new Set(), queries = new Map();
    return {
      attributes, style: {}, classes, dataset: {}, children: [],
      setAttribute(key, value) { attributes.set(key, String(value)); },
      getAttribute(key) { return attributes.get(key) ?? null; },
      removeAttribute(key) { attributes.delete(key); },
      get lastElementChild() { return this.children.at(-1); },
      get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; },
      querySelector(selector) {
        if (!queries.has(selector)) queries.set(selector, createElement());
        return queries.get(selector);
      },
      insertAdjacentHTML(position, html) {
        registerIds(html);
        if (position === 'beforeend') this.appendChild(createElement());
      },
      appendChild(node) { this.insertBefore(node, null); },
      insertBefore(node, before) {
        node.remove();
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
        node.parentNode = this;
        const id = node.getAttribute('id');
        if (id) nodes.set(id, node);
      },
      remove() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentNode = null;
      },
      getBoundingClientRect: () => ({}),
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      },
    };
  }
  registerIds(scene);
  const svg = nodes.get('scene');
  for (const id of ['cat-body', 'mouse', 'fx-layer']) svg.appendChild(nodes.get(id));

  const math = Object.create(Math);
  math.random = () => random;
  const sandbox = createContext({
    Math: math, navigator: { userAgent: 'test' },
    performance: { now: () => now },
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) { nextFrame = callback; },
    setTimeout() {},
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
  const keyboard = sandbox.SillyKeyboard.build(nodes.get('keyboard'));
  const modules = [];
  let fatigueModule, pushModule;
  if (fatigue) modules.push((ctx) => (fatigueModule = sandbox.SillyFatigue.create(ctx, { workSeconds, restSeconds, demo })));
  if (push) modules.push((ctx) => (pushModule = sandbox.SillyPush.create(ctx, { demo, enabled: pushEnabled, everySeconds: 5 })));
  if (fatigue) modules.push((ctx) => sandbox.SillyStatusBar.create(ctx, { fatigue: fatigueModule }));
  const pet = sandbox.SillyCat.createCat({ keyboard, eyesFollow: false, sleepSeconds, demo, modules, mouseSide });
  const update = (time) => { now = time; nextFrame(now); };
  update(0);
  return {
    pet, debug: pet.debug, keyboard, pushModule,
    get now() { return now; },
    select: (id) => sandbox.SillySpecies.select(id),
    rig: () => sandbox.SillySpecies.current.rig,
    node: (id) => nodes.get(id),
    advance(time) {
      assert.ok(time >= now, 'test clock cannot run backward');
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
