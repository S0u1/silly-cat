// 播放状态只控制耳机，不参与猫的睡眠和疲劳计时。
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 1000, TIMEOUT_MS = 2000, MAX_GAP_MS = 2500;
  const ON_MS = 360, OFF_MS = 280, FADE_MS = 200, SWAY_MS = 400;
  const CYCLE_ON_MS = 8000, CYCLE_MS = 12000;
  const NOTE_MS = 1600;
  const NOTES = [
    'M 8 0 H 10 Q 10 4 15 6 Q 18 8 15 12 Q 15 8 10 7 V 17 C 10 22 0 24 0 19 C 0 16 5 14 8 16 Z',
    'M 4 3 L 15 0 V 15 C 15 19 8 21 8 17 C 8 15 11 13 13 14 V 5 L 6 7 V 19 C 6 23 -1 24 -1 20 C -1 18 2 16 4 17 Z',
  ];
  const unit = (v) => Math.max(0, Math.min(1, v));

  function createListenGate({ onMs = 3000, offMs = 8000 } = {}) {
    let wearing = false, previous, since, last;
    return (active, now) => {
      if (now - last > MAX_GAP_MS) {
        if (previous) since = last;
        previous = false;
        if (now - since >= offMs) wearing = false;
      }
      if (active !== previous) since = now;
      previous = active;
      last = now;
      if (active !== wearing && now - since >= (active ? onMs : offMs)) wearing = active;
      return wearing;
    };
  }

  async function probe(invoke) {
    const deadline = performance.now() + TIMEOUT_MS;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, TIMEOUT_MS); });
    try {
      const result = await Promise.race([invoke('media_activity'), timeout]);
      return performance.now() < deadline ? result : undefined;
    } catch (_) {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  function createMediaPoller(invoke, onChange) {
    let run = null, unsupported = false;
    async function poll(current) {
      const start = performance.now();
      const result = await probe(invoke);
      if (run !== current) return; // 设置已关闭，或已开启新一轮；丢弃旧 IPC 的结果
      const now = performance.now();
      if (result?.supported === false) {
        unsupported = true;
        run = null;
        onChange(false, now);
        return;
      }
      onChange(current.gate(result?.supported === true && result.active === true, now), now);
      if (run === current) current.timer = setTimeout(() => poll(current), Math.max(0, POLL_MS - (now - start)));
    }
    return {
      setEnabled(enabled) {
        if (enabled) {
          if (!invoke || unsupported || run) return;
          run = { gate: createListenGate() };
          poll(run);
        } else if (run) {
          clearTimeout(run.timer);
          run = null;
          onChange(false, performance.now());
        }
      },
    };
  }

  // 现有头形用绝对 M/L/C/Z 命令，数值都是成对的坐标。曲线用控制点的外接框。
  function headBounds(d) {
    const xy = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < xy.length; i += 2) {
      bounds.x0 = Math.min(bounds.x0, xy[i]);
      bounds.x1 = Math.max(bounds.x1, xy[i]);
      bounds.y0 = Math.min(bounds.y0, xy[i + 1]);
      bounds.y1 = Math.max(bounds.y1, xy[i + 1]);
    }
    return bounds;
  }

  function geometry({ x0, x1, y0, y1 }) {
    const w = x1 - x0, k = w / 260, cx = (x0 + x1) / 2;
    const left = x0 + 2 * k, right = x1 - 2 * k, cy = (y0 + y1) / 2;
    return { w, k, cx, cy, left, right, top: y0 + 8 * k, cupW: 40 * k, cupH: 62 * k };
  }

  function svg(tag, className, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute('class', className);
    parent.appendChild(node);
    return node;
  }

  function makeHeadset(parent) {
    const group = svg('g', 'hp-headset', parent);
    group.setAttribute('aria-hidden', 'true');
    group.style.display = 'none';
    return { group };
  }

  function layout(headset, bounds) {
    const { group } = headset;
    const g = headset.geometry = geometry(bounds);
    const { k, cx, cy, left, right, cupW, cupH } = g;
    const arc = (inset) => {
      const rx = cx - left - inset, ry = cy - g.top - inset;
      return `M ${left + inset} ${cy} A ${rx} ${ry} 0 0 1 ${right - inset} ${cy}`;
    };
    const sides = [[left, 1], [right, -1]];
    const rects = (name, w, h, r, offset) => sides.map(([x, inward]) =>
      `<rect class="hp-${name}" x="${x + offset * inward - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${r}"/>`
    ).join('');
    group.innerHTML = `
      <path class="hp-band-outline" d="${arc(0)}" stroke-width="${10 * k + 8}"/>
      <path class="hp-band" d="${arc(0)}" stroke-width="${10 * k}"/>
      <path class="hp-band-shine" d="${arc(2 * k)}"/>
      ${rects('pad', 12 * k, 50 * k, 6 * k, cupW / 2 + 2 * k)}
      ${rects('cup', cupW, cupH, 16 * k, 0)}
      ${rects('plate', 24 * k, 44 * k, 10 * k, -3 * k)}`;
  }

  function updatePath(headset, path) {
    const d = path.getAttribute('d'), transform = path.getAttribute('transform');
    if (d === headset.d && transform === headset.transform) return;
    if (d !== headset.d) headset.bounds = headBounds(d);
    headset.d = d;
    headset.transform = transform;
    const bounds = { ...headset.bounds };
    // 毛绒自定义头形鼓腮时，art.js 缩放裁切路径而不重写 d。
    const list = path.transform.baseVal;
    for (let i = list.numberOfItems - 1; i >= 0; i--) {
      const { a, d: sy, e, f } = list.getItem(i).matrix;
      bounds.x0 = a * bounds.x0 + e;
      bounds.x1 = a * bounds.x1 + e;
      bounds.y0 = sy * bounds.y0 + f;
      bounds.y1 = sy * bounds.y1 + f;
    }
    layout(headset, bounds);
  }

  function updateBack(headset, head) {
    // 毛绒背影用独立且紧裁的头图，线条背影用原 SVG 路径。
    const image = head.querySelector(':scope > image');
    if (!image) {
      if (headset.image) headset.d = null;
      headset.image = null;
      updatePath(headset, head.querySelector(':scope > path.coat-base'));
    } else if (image !== headset.image) {
      headset.image = image;
      const x0 = +image.getAttribute('x'), y0 = +image.getAttribute('y');
      layout(headset, {
        x0, y0, x1: x0 + +image.getAttribute('width'), y1: y0 + +image.getAttribute('height'),
      });
    }
  }

  function sample(transition, wearing, now, rm) {
    if (!transition) return { y: wearing ? 0 : -0.18, opacity: Number(wearing), done: true };
    const elapsed = now - transition.start;
    const p = unit(elapsed / (rm ? FADE_MS : wearing ? ON_MS : OFF_MS));
    const { from } = transition;
    const targetY = wearing ? 0 : -0.2;
    const easeOutBack = 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
    const move = wearing ? easeOutBack : p ** 3;
    const fade = !rm && wearing ? unit(elapsed / 120) : p;
    return {
      y: rm ? 0 : from.y + (targetY - from.y) * move,
      opacity: from.opacity + (Number(wearing) - from.opacity) * fade,
      done: p >= 1,
    };
  }

  function create(ctx, { invoke, preview, isPushing } = {}) {
    const { S, STATES, el, headToScene, reducedMotion } = ctx;
    const start = performance.now();
    const front = makeHeadset(el.head);
    const backHead = document.getElementById('strike-head-shape');
    const back = makeHeadset(backHead);
    const noteLayer = svg('g', 'hp-notes', document.getElementById('fx-layer'));
    noteLayer.setAttribute('aria-hidden', 'true');
    let wearing = preview === '1', transition = null;
    let mix = 0, lastPose = start, nextNote = null, noteKind = 0, canFloat = false;
    const notes = [];

    function setWearing(on, now) {
      if (wearing === on) return;
      transition = { start: now, from: sample(transition, wearing, now, reducedMotion()) };
      wearing = on;
    }
    const poller = createMediaPoller(invoke, setWearing);

    function pose(now, dt, rm, P) {
      if (preview === 'cycle') {
        const phase = (now - start) % CYCLE_MS;
        setWearing(phase < CYCLE_ON_MS, now - phase + (phase < CYCLE_ON_MS ? 0 : CYCLE_ON_MS));
      }
      canFloat = !rm && S.state === STATES.AWAKE && !S.pet && !P.hideCat && !isPushing?.(now);
      const idle = canFloat && wearing && now - Math.max(S.lastInput, S.lastPointerMove) >= 1500;
      const step = (now - lastPose) / SWAY_MS;
      lastPose = now;
      mix = rm ? 0 : unit(mix + (idle ? step : -step));
      if (mix > 0) {
        const beat = (1 - Math.cos(now * 2 * Math.PI / 600)) / 2;
        P.headRot += 3.2 * mix * Math.sin(now * 2 * Math.PI / 1200);
        P.headY += 1.2 * mix * beat;
        P.tailTipLift = 4 * mix * beat;
      }
      if (!idle) nextNote = null;
      else if (nextNote === null) scheduleNote(now);
    }

    function scheduleNote(now) {
      nextNote = now + 2400 + Math.random() * 1200;
    }

    function spawn(now) {
      if (notes.length >= 2) return;
      const { left, right, cy, cupH } = front.geometry;
      const at = headToScene(Math.random() < 0.5 ? left : right, cy - cupH / 2 - 6);
      const node = svg('path', 'hp-note', noteLayer);
      node.setAttribute('d', NOTES[noteKind]);
      noteKind = 1 - noteKind;
      notes.push({ node, at, start: now, drift: Math.random() < 0.5 ? -1 : 1 });
    }

    function render(now, dt, rm) {
      if (wearing || transition) {
        const frame = sample(transition, wearing, now, rm);
        updatePath(front, el.headClip);
        updateBack(back, backHead);
        for (const headset of [front, back]) {
          const { group, geometry: g } = headset;
          group.style.display = !wearing && frame.done ? 'none' : '';
          group.setAttribute('transform', `translate(0 ${frame.y * g.w})`);
          group.setAttribute('opacity', frame.opacity);
        }
        if (transition && frame.done) {
          transition = null;
          if (wearing && canFloat) {
            spawn(now);
            if (nextNote !== null) scheduleNote(now);
          }
        }
      }
      if (nextNote !== null && now >= nextNote) {
        spawn(now);
        scheduleNote(now);
      }
      for (let i = notes.length - 1; i >= 0; i--) {
        const { node, at, start, drift } = notes[i];
        const t = now - start, u = t / NOTE_MS;
        if (!canFloat || t >= NOTE_MS) {
          node.remove();
          notes.splice(i, 1);
          continue;
        }
        node.setAttribute('opacity', unit(Math.min(t / 150, (NOTE_MS - t) / 500)));
        node.setAttribute('transform',
          `translate(${at.x + 8 * drift * u} ${at.y - 40 * u}) rotate(${10 * drift * u}) translate(-7 -22)`);
      }
    }

    return { pose, render, setEnabled: poller.setEnabled };
  }

  window.SillyHeadphones = { create, createListenGate, createMediaPoller, probe, headBounds, geometry };
})();
