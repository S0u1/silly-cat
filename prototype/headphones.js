// 播放状态独立于睡眠和疲劳计时。
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
  const STICKERS = Object.freeze({
    strawberry: 'M 0 4 C -6 -3 -12 3 0 11 C 12 3 6 -3 0 4 Z',
    mint: 'M 2 -9 L 9 -11 V 3 C 9 7 3 8 3 5 C 3 3 6 2 7 3 V -6 L 4 -5 V 6 C 4 10 -2 11 -2 8 C -2 6 1 5 2 6 Z',
    latte: 'M -5 4 C -9 4 -9 10 -5 11 C -2 12 2 12 5 11 C 9 10 9 4 5 4 C 3 2 -3 2 -5 4 Z M -8 -2 a 2.6 3.2 0 1 0 0.1 0 Z M -3 -6 a 2.6 3.2 0 1 0 0.1 0 Z M 3 -6 a 2.6 3.2 0 1 0 0.1 0 Z M 8 -2 a 2.6 3.2 0 1 0 0.1 0 Z',
    sky: 'M 0 -9 L 2.6 -3 L 9 -2.8 L 4 1.4 L 5.6 8 L 0 4.4 L -5.6 8 L -4 1.4 L -9 -2.8 L -2.6 -3 Z',
  });
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

  // 正面看耳罩只露侧边：竖胶囊贴在头两侧，内缘缩进头轮廓外 2k，被头和毛挡住一部分。
  // left/right 是两侧耳罩侧边的中线，rx/ry 是侧边的半宽、半高。
  const CUP_W = 27, CUP_H = 70, CUP_GAP = 2;
  // 贴纸在头顶软垫上居中：各图形自身的竖向中心。
  const STICKER_CY = Object.freeze({ strawberry: 4.5, mint: 0, latte: 1.5, sky: -0.5 });

  function geometry({ x0, x1, y0, y1 }, fit = window.SillySpecies.current.headphones.fit) {
    const w = x1 - x0, k = w / fit.referenceWidth, cx = (x0 + x1) / 2;
    const rx = CUP_W / 2 * k, ry = CUP_H / 2 * k;
    const left = x0 - CUP_GAP * k - rx, right = x1 + CUP_GAP * k + rx, cy = y0 + fit.cupY * (y1 - y0);
    return {
      w, k, cx, cy, left, right, top: y0 + fit.bandY * k, rx, ry,
      noteX: fit.noteX * k, noteY: (y0 + y1) / 2 + fit.noteY * k - fit.noteRise,
    };
  }

  function stickerTransform(color, { k, cx, top }) {
    const s = 0.85 * k;
    return `translate(${cx} ${top - STICKER_CY[color] * s}) scale(${s})`;
  }

  function svg(tag, className, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute('class', className);
    parent.appendChild(node);
    return node;
  }

  function makeHeadset(rear) {
    const parent = rear.parentNode;
    rear.setAttribute('class', 'hp-headset hp-headset-rear');
    const foreground = svg('g', 'hp-headset hp-headset-front', parent);
    const layers = [rear, foreground];
    for (const layer of layers) {
      layer.setAttribute('aria-hidden', 'true');
      layer.style.display = 'none';
    }
    return { parent, rear, foreground, layers };
  }

  function layout(headset, bounds, fit) {
    const { rear, foreground, color } = headset;
    const g = headset.geometry = geometry(bounds, fit);
    headset.fit = fit;
    const { k, cx, cy, left, right, top, rx, ry } = g;
    const y = cy - ry; // 耳罩侧边顶端
    const ya = y - 4 * k; // 头带两端落在支架里
    const arc = `M ${left} ${ya} A ${(right - left) / 2} ${ya - top} 0 0 1 ${right} ${ya}`;
    // inward：画面左侧为 1（向右是头内侧），右侧为 -1。
    const sides = [[left, 1], [right, -1]];
    rear.innerHTML = sides.map(([x, inward]) => {
      const inner = x + inward * rx, outer = x - inward * rx;
      const padX = inner - inward * 3 * k;
      const rim = outer + inward * 8 * k;
      return `<g>
        <rect class="hp-pad" x="${Math.min(padX, padX + inward * 9 * k)}" y="${cy - 28 * k}"
          width="${9 * k}" height="${56 * k}" rx="${4.5 * k}"/>
        <rect class="hp-cup" x="${x - rx}" y="${y}" width="${2 * rx}" height="${2 * ry}" rx="${rx}"/>
        <path class="hp-line hp-rim" d="M ${rim} ${y + 9 * k} Q ${rim - inward * 1.5 * k} ${cy} ${rim} ${y + 2 * ry - 9 * k}"
          stroke-width="${6 * k}"/>
        <path class="hp-line hp-cup-shine" d="M ${x + inward * 2 * k} ${y + 12 * k} V ${y + 30 * k}"/>
      </g>`;
    }).join('');
    foreground.innerHTML = `
      <path class="hp-line hp-band-outline" d="${arc}" stroke-width="${12 * k + 9}"/>
      <path class="hp-line hp-band" d="${arc}" stroke-width="${12 * k}"/>
      <rect class="hp-cushion" x="${cx - 31 * k}" y="${top - 11 * k}" width="${62 * k}" height="${22 * k}" rx="${11 * k}"/>
      <rect class="hp-seam" x="${cx - 25 * k}" y="${top - 5 * k}" width="${50 * k}" height="${10 * k}" rx="${5 * k}"/>
      <path class="hp-sticker" d="${STICKERS[color]}" transform="${stickerTransform(color, g)}"/>
      ${sides.map(([x]) => `
        <rect class="hp-bracket" x="${x - 5 * k}" y="${y - 12 * k}" width="${10 * k}" height="${20 * k}" rx="${4 * k}"/>`).join('')}`;
  }

  function updatePath(headset, path, fit) {
    const d = path.getAttribute('d'), transform = path.getAttribute('transform');
    if (d === headset.d && transform === headset.transform && fit === headset.fit) return;
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
    layout(headset, bounds, fit);
  }

  function updateBack(headset, fit) {
    // 毛绒背影用独立且紧裁的头图，线条背影用原 SVG 路径。
    const head = headset.parent;
    const image = head.querySelector(':scope > image');
    if (!image) {
      if (headset.image) headset.d = null;
      headset.image = null;
      updatePath(headset, head.querySelector(':scope > path.coat-base'), fit);
    } else if (image !== headset.image || fit !== headset.fit) {
      headset.image = image;
      const x0 = +image.getAttribute('x'), y0 = +image.getAttribute('y');
      layout(headset, {
        x0, y0, x1: x0 + +image.getAttribute('width'), y1: y0 + +image.getAttribute('height'),
      }, fit);
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

  function create(ctx, { invoke, preview, color, isPushing } = {}) {
    const { S, STATES, el, headToScene, reducedMotion } = ctx;
    const start = performance.now();
    const front = makeHeadset(document.getElementById('head-rear-accessories'));
    const back = makeHeadset(document.getElementById('back-head-rear-accessories'));
    const noteLayer = svg('g', 'hp-notes', document.getElementById('fx-layer'));
    noteLayer.setAttribute('aria-hidden', 'true');

    function setColor(value) {
      const next = window.SillySettings.normalizeHeadphoneColor(value);
      if (front.color === next) return;
      for (const headset of [front, back]) {
        headset.color = next;
        for (const layer of headset.layers) layer.dataset.hpColor = next;
        for (const sticker of headset.foreground.querySelectorAll('.hp-sticker')) {
          sticker.setAttribute('d', STICKERS[next]);
          if (headset.geometry) sticker.setAttribute('transform', stickerTransform(next, headset.geometry));
        }
      }
    }
    setColor(color);

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
        const { headRotation, headDip, tailLift } = window.SillySpecies.current.headphones.sway;
        P.headRot += headRotation * mix * Math.sin(now * 2 * Math.PI / 1200);
        P.headY += headDip * mix * beat;
        P.tailTipLift = tailLift * mix * beat;
      }
      if (!idle) nextNote = null;
      else if (nextNote === null) scheduleNote(now);
    }

    function scheduleNote(now) {
      nextNote = now + 2400 + Math.random() * 1200;
    }

    function spawn(now) {
      if (notes.length >= 2) return;
      const { cx, noteX, noteY } = front.geometry;
      const at = headToScene(cx + (Math.random() < 0.5 ? -noteX : noteX), noteY);
      const node = svg('path', 'hp-note', noteLayer);
      node.setAttribute('d', NOTES[noteKind]);
      noteKind = 1 - noteKind;
      notes.push({ node, at, start: now, drift: Math.random() < 0.5 ? -1 : 1 });
    }

    function render(now, dt, rm) {
      if (wearing || transition) {
        const frame = sample(transition, wearing, now, rm);
        const { fit } = window.SillySpecies.current.headphones;
        updatePath(front, el.headClip, fit);
        updateBack(back, fit);
        for (const { layers, geometry: { w } } of [front, back]) {
          for (const layer of layers) {
            layer.style.display = !wearing && frame.done ? 'none' : '';
            layer.setAttribute('transform', `translate(0 ${frame.y * w})`);
            layer.setAttribute('opacity', frame.opacity);
          }
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

    return { pose, render, setColor, setEnabled: poller.setEnabled };
  }

  window.SillyHeadphones = { create, createListenGate, createMediaPoller, probe, headBounds, geometry, STICKERS };
})();
