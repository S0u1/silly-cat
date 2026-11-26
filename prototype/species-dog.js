// 中华田园犬的坐姿、五官和动作锚点沿用 800 × 620 舞台坐标。
(function () {
  'use strict';

  const cat = window.SillySpecies.get('cat');
  const { rig } = cat;
  function smoothstep(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  function midScale(y) {
    return 1 - 0.10 * smoothstep((268 - y) / 43);
  }

  // Match the v5 crown warp and the v6 cheek warp baked into the art.
  function narrowScale(y) {
    return (1 - 0.15 * smoothstep((250 - y) / 170)) * midScale(y);
  }

  function narrowPoint(x, y) {
    return { x: Number((400 + (x - 400) * narrowScale(y)).toFixed(3)), y };
  }

  function narrowOutline(x, y, curves) {
    const point = (x, y) => `${narrowPoint(x, y).x} ${Number(y.toFixed(3))}`;
    let d = `M ${point(x, y)}`;
    for (const [ax, ay, bx, by, endX, endY] of curves) {
      if (Math.min(y, ay, by, endY) >= 268) {
        d += ` C ${ax} ${ay} ${bx} ${by} ${endX} ${endY}`;
      } else {
        // A row-dependent warp does not preserve cubic control points.
        for (let i = 1; i <= 24; i++) {
          const t = i / 24, u = 1 - t;
          const sample = (p, a, b, q) => u ** 3 * p + 3 * u * u * t * a + 3 * u * t * t * b + t ** 3 * q;
          d += ` L ${point(sample(x, ax, bx, endX), sample(y, ay, by, endY))}`;
        }
      }
      x = endX;
      y = endY;
    }
    return d;
  }

  const mouthCorner = { x: 420.939, y: 236 };
  const imprintPivot = { x: 309.227, y: 237 };
  const imprintOffset = { dx: 28.52, dy: -6 };
  // The flush and dents share this translation. Their pivot is in group coordinates.
  const paintedImprintX = imprintPivot.x + imprintOffset.dx;
  imprintOffset.dx += (paintedImprintX - 400) * (midScale(imprintPivot.y + imprintOffset.dy) - 1);
  const earPivots = { L: narrowPoint(327, 102), R: narrowPoint(473, 102) };
  const headPath = narrowOutline(400, 80, [
    [470, 80, 528, 108, 532, 168], [536, 214, 500, 246, 458, 270],
    [440, 282, 424, 292, 400, 292], [376, 292, 360, 282, 342, 270],
    [300, 246, 264, 214, 268, 168], [272, 108, 330, 80, 400, 80],
  ]) + ' Z';
  const earOutline = narrowOutline(295, 119, [
    [286, 98, 291, 53, 305, 42], [321, 28, 346, 60, 365, 85],
    [371, 98, 365, 120, 350, 133],
  ]) + ` L ${narrowPoint(306, 132).x} 132 Z`;
  const innerEarPath = narrowOutline(302, 110, [
    [299, 90, 302, 58, 310, 53],
    [310 + 32 / 3, 53 - 10 / 3, 334, 88 - 80 / 3, 350, 88],
    [334, 88 + 22 / 3, 318, 110 - 22 / 3, 302, 110],
  ]) + ' Z';
  const muzzlePath = narrowOutline(400, 182, [
    [424, 182, 446, 214, 452, 246], [458, 274, 432, 292, 400, 292],
    [368, 292, 342, 274, 348, 246], [354, 214, 376, 182, 400, 182],
  ]) + ' Z';
  const cheek = { ...rig.head.cheek, imagePivot: { x: 400, y: 227 } };
  const strikeTail = 'M 489 376 C 513 374 540 365 550 346 C 564 325 559 307 542 300 Q 528 292 510 294';

  function frontHeadPath(amount) {
    if (!amount) return headPath;
    const { imagePivot: { x, y }, scaleX, scaleY } = cheek;
    // Match the head image's cheek transform for the vector outline and clip.
    return headPath.replace(/([\d.]+) ([\d.]+)/g, (_, px, py) => {
      const sx = x + (Number(px) - x) * (1 + scaleX * amount);
      const sy = y + (Number(py) - y) * (1 + scaleY * amount);
      return `${sx.toFixed(2)} ${sy.toFixed(2)}`;
    });
  }

  window.SillySpecies.register('dog', {
    scene: {
      template: 'parts-dog',
      attributes(dogRig) {
        const body = 'M 400 244 C 339 244 312 282 294 320 C 274 336 265 361 275 390 ' +
          'C 288 429 321 432 400 432 C 479 432 512 429 525 390 C 535 361 526 336 506 320 ' +
          'C 488 282 461 244 400 244';
        return [
          ['#cat-body > .coat-base, #strike-body > .coat-base, #clip-body path, #clip-back-body path, #mask-tail-body', { d: body + ' Z' }],
          ['#cat-body > .ink-line, #strike-body > .ink-line', { d: body }],
          ['#cat-body > .ink-thin', { d: 'M 293 362 Q 302 379 318 386 M 507 362 Q 498 379 482 386' }],
          ['#strike-tail > path', { d: strikeTail }],
          ['#strike-head-shape > path, #clip-back-head path, #head-fill, #head-line, #clip-head-path', { d: dogRig.head.backPath }],
          ['#scene .dog-ear-outline', { d: dogRig.ears.outline }],
          ['#scene .coat-inner-ear', { d: dogRig.ears.innerPath }],
          ['.imprint-flush', { cx: imprintPivot.x, cy: imprintPivot.y, rx: '34.913', ry: '22' }],
          ['#sweat', { d: 'M 469.315 127 Q 463.572 141 464.968 146 C 465.391 156 478.973 156 478.472 146 Q 478.772 141 469.315 127 Z' }],
          ['#imprint-tuft', { d: 'M 311.898 242 L 303.959 240 M 319.809 249 L 312.808 252' }],
        ];
      },
    },
    art: {
      // prepare_art crops the source alpha bounds and adds 6 px on each side.
      head: { cx: 400, cy: 184.625, width: 234 },
      backHead: { cx: 400, cy: 184, width: 234 },
      imprint: imprintOffset,
      ear: { x: 313.25, y: 37.5, width: 63.25, pivot: earPivots.L },
      earBack: { x: 313, width: 63.5 },
      body: { cx: 398.25, y: 241.5, width: 258.5 },
      backBody: { cx: 399.25, y: 241.5, width: 252.5 },
      paw: { cx: 0, cy: 2, width: 68 },
      arm: { width: 57, top: 19, bottom: 7, segments: 8, overlap: 1.45 },
      tail: { fringe: 4, top: 3, bottom: 2, segments: 24, overlap: 1.35, scale: 0.94 },
    },
    coatShape: { ...cat.coatShape },
    mousePaw: true,
    mouseReach: {
      inset: 23, rise: 79, degrees: 8, slide: 8, shoulderX: 15, shoulderY: 27,
      stretch: 1.35, bend: 17, tau: 85,
    },
    idleTilt: true,
    tailTyping: true,
    petTongue: true,
    push: null,
    sleep: {
      ...cat.sleep,
      droolAnchor: mouthCorner,
      wipeAnchor: { x: 412.981, y: 240 },
      zzzAnchor: narrowPoint(530, 76),
      contactShape: { cx: 400, cy: 185, rx: 126 * narrowScale(185), ry: 104 },
      imprintPivot,
      slump: {
        nod: { ...cat.sleep.slump.nod, dip: [52, 98], finalDip: 50, land: 138 },
        melt: { ...cat.sleep.slump.melt, hy: 169 },
      },
    },
    fatigue: {
      ...cat.fatigue,
      browMoods: ['angry'],
      sigh: { ...cat.fatigue.sigh, anchor: mouthCorner },
      angry: { ...cat.fatigue.angry, symbol: narrowPoint(474, 93), cheek: 15 },
      strike: {
        ...cat.fatigue.strike,
        hmph: { l: narrowPoint(292, 94), r: narrowPoint(508, 94) },
        tail: { pivot: { x: 489, y: 376 }, angle: -4 },
        ears: { ...cat.fatigue.strike.ears, pivots: { l: earPivots.L, r: earPivots.R }, rest: 4 },
      },
      repairGhost: {
        L: { paint: 'ghost-white', rx: 25, ry: 16 },
        R: { paint: 'ghost-white', rx: 25, ry: 16 },
      },
    },
    headphones: {
      fit: { ...cat.headphones.fit, referenceWidth: 247, cupY: 0.44, bandY: 3, noteY: -42 },
      sway: { ...cat.headphones.sway, tailLift: 2 },
    },
    rig: {
      ...rig,
      head: {
        ...rig.head,
        pivot: { x: 400, y: 281 },
        restRotation: 0,
        sleepRotation: -4,
        cheek,
        path: frontHeadPath,
        backPath: headPath,
        muzzlePath,
      },
      eyes: {
        style: 'puppy',
        centers: { L: narrowPoint(356, 170), R: narrowPoint(444, 170) },
        radius: 18, lidPadding: 2, restLid: 0,
        pupil: { rest: 18, excited: 18 },
        shine: { x: -6.6, y: -7, radius: 4.8 },
        glint: { x: 0.4, y: -12.2, radius: 1.9 },
        gaze: { max: 5, taper: 0, restY: 0, keyX: 4, keyY: 2 },
        arcs: {
          closed: { halfWidth: 15, edgeY: 2, controlY: 12 },
          happy: { halfWidth: 15, edgeY: 5, controlY: -11 },
        },
      },
      ears: {
        ...rig.ears,
        pivots: earPivots,
        outline: earOutline,
        innerPath: innerEarPath,
        twitch: { ...rig.ears.twitch, degrees: 10 },
      },
      paws: {
        ...rig.paws,
        shoulders: { L: { x: 463, y: 291 }, R: { x: 337, y: 291 } },
        bend: { base: 33, falloff: 0.34, min: 1, max: 33 },
      },
      tail: {
        ...rig.tail,
        pivot: { x: 304, y: 367 },
        idleCurves: [
          { points: [304, 367, 272, 378, 249, 365, 238, 342], steps: 26 },
          { points: [238, 342, 225, 316, 247, 304, 260, 298], steps: 24 },
          { points: [260, 298, 266, 296, 273, 291, 278, 290], steps: 8 },
        ],
        halfWidth: (s) => 21 + 9 * s + 8 * Math.max(0, 1 - ((s - 0.63) / 0.22) ** 2) ** 2,
        tipLength: 25,
        strikeDiameter: 62,
        wag: {
          ...rig.tail.wag,
          awake: { amp: 5, speed: 0.005 },
          drowsy: { amp: 2, speed: 0.003 },
          excited: { amp: 18, speed: 0.025 },
          asleep: { amp: 0, speed: 0, base: 0, tau: 380 },
        },
      },
      zzz: { origin: narrowPoint(522, 76) },
    },
  });
})();
