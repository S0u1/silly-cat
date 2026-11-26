// 眼睛沿用 cat.js 的快响应。头和独立五官在同一目标上再做一层较慢的视差。
(function () {
  'use strict';

  function direction(point) {
    const dx = point.x - 400, dy = point.y - 178;
    const distance = Math.max(160, Math.hypot(dx, dy));
    return { x: dx / distance, y: dy / distance };
  }

  function turn(P, x, y) {
    P.headX += 8 * x;
    P.headY += 4 * y;
    P.headRot += 6 * x;
  }

  function create({ S, STATES, el, approach, f1, followsPointer, pointerInScene }) {
    const features = el.head.querySelectorAll('.gaze-features');
    let x = 0, y = 0, drawn = '';
    return {
      pose(now, dt, rm, P) {
        if (S.pet || P.look || P.hideCat || P.eyesClosed || P.eyesHappy ||
            (S.state !== STATES.AWAKE && S.state !== STATES.DROWSY)) {
          x = y = 0;
        } else {
          const point = followsPointer(now, P) ? pointerInScene() : null;
          const target = point ? direction(point) : { x: 0, y: 0 };
          const drowsy = S.state === STATES.DROWSY;
          const amount = drowsy ? 0.5 : 1;
          const tau = drowsy ? 420 : 220;
          x = approach(x, target.x * amount, dt, tau);
          y = approach(y, target.y * amount, dt, tau);
          turn(P, x, y);
        }
        const dx = f1(5 * x), dy = f1(5 * y);
        const transform = dx === '0' && dy === '0' ? '' : `translate(${dx} ${dy})`;
        if (transform === drawn) return;
        drawn = transform;
        for (const feature of features) feature.setAttribute('transform', transform);
      },
    };
  }

  window.SillyHeadFollow = { create, direction, turn };
})();
