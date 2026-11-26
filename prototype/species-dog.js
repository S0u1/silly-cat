// 中华田园犬的坐姿、五官和动作锚点沿用 800 × 620 舞台坐标。
(function () {
  'use strict';

  const cat = window.SillySpecies.get('cat');
  const { rig } = cat;
  const mouthCorner = { x: 424, y: 236 };
  const earPivots = { L: { x: 330, y: 104 }, R: { x: 470, y: 104 } };

  function headPath(cheek) {
    // 原曲线以 1/40 间隔采样为 .art-src/guides/head-tianyuan.path。
    const b = Math.round(cheek * 10) / 10;
    return 'M 400 72 C 462 72, 522 102, 529 158 ' +
      `C ${535 + b} 200, ${522 + b} 234, ${492 + b / 2} 254 ` +
      `C ${476 + b / 2} 264, 467 272, 463 283 C 457 295, 432 300, 400 300 ` +
      `C 368 300, 343 295, 337 283 C 333 272, ${324 - b / 2} 264, ${308 - b / 2} 254 ` +
      `C ${278 - b} 234, ${265 - b} 200, 271 158 C 278 102, 338 72, 400 72 Z`;
  }

  window.SillySpecies.register('dog', {
    scene: {
      template: 'parts-dog',
      attributes(dogRig) {
        const body = 'M 282 414 C 277 386, 278 349, 287 319 C 297 280, 335 258, 400 258 ' +
          'C 465 258, 503 280, 513 319 C 522 349, 523 386, 518 414';
        const tail = 'M 400 405 C 450 407, 503 399, 548 377 C 582 360, 594 325, 577 304 C 565 289, 541 289, 535 309';
        return [
          ['#cat-body > .coat-base, #strike-body > .coat-base, #clip-body path, #clip-back-body path, #mask-tail-body', { d: body + ' Z' }],
          ['#cat-body > .ink-line, #strike-body > .ink-line', { d: body }],
          ['#cat-body > .ink-thin', { d: 'M 293 362 Q 302 379 318 386 M 507 362 Q 498 379 482 386' }],
          ['#strike-tail > path', { d: tail }],
          ['#strike-head-shape > path, #clip-back-head path, #head-fill, #head-line, #clip-head-path', { d: dogRig.head.backPath }],
          ['#scene .dog-ear-outline', { d: dogRig.ears.outline }],
          ['.imprint-flush', { cx: '318', cy: '240', rx: '38', ry: '23' }],
          ['#sweat', { d: 'M 505 118 Q 497 132 498 137 A 7.5 7.5 0 0 0 513 137 Q 514 132 505 118 Z' }],
          ['#imprint-tuft', { d: 'M 309 252 L 298 254 M 318 260 L 309 266' }],
        ];
      },
    },
    art: {
      head: { cx: 400, cy: 186, width: 260 },
      imprint: { dx: 37, dy: 8 },
      ear: { x: 292, y: 18, width: 96, pivot: earPivots.L },
      body: { cx: 400, y: 246, width: 250 },
      paw: { ...cat.art.paw },
      arm: { ...cat.art.arm },
      tail: { ...cat.art.tail },
    },
    coatShape: { ...cat.coatShape },
    mousePaw: true,
    idleTilt: true,
    tailTyping: true,
    petTongue: true,
    push: null,
    sleep: {
      ...cat.sleep,
      droolAnchor: mouthCorner,
      wipeAnchor: { x: 414, y: 242 },
      zzzAnchor: { x: 542, y: 76 },
      contactShape: { cx: 400, cy: 187, rx: 128, ry: 112 },
      slump: {
        nod: { ...cat.sleep.slump.nod, dip: [52, 98], finalDip: 50, land: 138 },
        melt: { ...cat.sleep.slump.melt, hy: 169 },
      },
    },
    fatigue: {
      ...cat.fatigue,
      browMoods: ['angry'],
      sigh: { ...cat.fatigue.sigh, anchor: mouthCorner },
      angry: { ...cat.fatigue.angry, symbol: { x: 480, y: 88 }, cheek: 15 },
      strike: {
        ...cat.fatigue.strike,
        hmph: { l: { x: 292, y: 94 }, r: { x: 508, y: 94 } },
        tail: { pivot: { x: 517, y: 389 }, angle: -10 },
        ears: { ...cat.fatigue.strike.ears, pivots: { l: earPivots.L, r: earPivots.R } },
      },
      repairGhost: {
        L: { paint: 'ghost-white', rx: 25, ry: 16 },
        R: { paint: 'ghost-white', rx: 25, ry: 16 },
      },
    },
    headphones: {
      fit: { ...cat.headphones.fit, referenceWidth: 270, cupY: 0.47, bandY: 4, noteY: -42 },
      sway: { ...cat.headphones.sway, tailLift: 2 },
    },
    rig: {
      ...rig,
      head: {
        ...rig.head,
        pivot: { x: 400, y: 281 },
        restRotation: 0,
        sleepRotation: -4,
        cheek: { ...rig.head.cheek, imagePivot: { x: 400, y: 235 } },
        path: headPath,
        backPath: headPath(0),
      },
      eyes: {
        ...rig.eyes,
        centers: { L: { x: 352, y: 166 }, R: { x: 448, y: 166 } },
        radius: 27,
        irisRadius: 20,
      },
      ears: {
        ...rig.ears,
        pivots: earPivots,
        tipFold: 0,
        get outline() {
          const fold = this.tipFold;
          return `M 291 130 C 286 97 291 60 ${300 + fold} ${35 + fold} ` +
            `Q ${304 + fold} ${25 + fold} ${311 + fold} ${32 + fold} C 333 52 350 83 361 113 L 351 140 Z`;
        },
        twitch: { ...rig.ears.twitch, degrees: 10 },
      },
      paws: {
        ...rig.paws,
        bend: { base: 33, falloff: 0.34, min: 1, max: 33 },
      },
      tail: {
        ...rig.tail,
        idleCurves: [
          { points: [322, 372, 277, 388, 234, 383, 211, 352], steps: 26 },
          { points: [211, 352, 190, 324, 203, 290, 232, 289], steps: 23 },
          { points: [232, 289, 249, 288, 261, 298, 257, 310], steps: 14 },
        ],
        halfWidth: (s) => 15 - 5 * s * s,
        tipLength: 25,
        strikeDiameter: 32,
        wag: {
          ...rig.tail.wag,
          awake: { amp: 5, speed: 0.005 },
          drowsy: { amp: 2, speed: 0.003 },
          excited: { amp: 18, speed: 0.025 },
          asleep: { amp: 0, speed: 0, base: 0, tau: 380 },
        },
      },
      zzz: { origin: { x: 522, y: 76 } },
    },
  });
})();
