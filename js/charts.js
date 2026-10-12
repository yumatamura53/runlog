// 軽量な SVG グラフ（折れ線＋十字線ツールチップ、棒グラフ、カレンダー）
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function tooltip(container) {
  let tip = container.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    tip.innerHTML = '<strong></strong><span></span>';
    container.appendChild(tip);
  }
  return {
    show(x, y, value, label) {
      tip.firstChild.textContent = value;
      tip.lastChild.textContent = label;
      tip.hidden = false;
      const w = container.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x - tw / 2), w - tw)}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/**
 * 折れ線（面）グラフ。data: [{x, y}]
 * opts: { height, xFmt, yFmt, xLabel, invert(小さいほど上), area, onHover(i|null), ariaLabel }
 */
export function lineChart(container, data, opts = {}) {
  container.replaceChildren();
  container.classList.add('chart');
  if (data.length < 2) { container.hidden = true; return null; }
  container.hidden = false;
  const W = container.clientWidth || 320, H = opts.height || 140;
  const m = { l: 44, r: 8, t: 10, b: 22 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' }, container);

  const xs = data.map((d) => d.x), ys = data.map((d) => d.y).filter((v) => v != null && isFinite(v));
  const x0 = xs[0], x1 = xs[xs.length - 1];
  let y0 = opts.yMin ?? Math.min(...ys), y1 = opts.yMax ?? Math.max(...ys);
  if (y1 - y0 < (opts.minSpan || 1)) { const c = (y0 + y1) / 2; y0 = c - (opts.minSpan || 1) / 2; y1 = c + (opts.minSpan || 1) / 2; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const sy = (y) => opts.invert ? m.t + ((y - y0) / (y1 - y0)) * (H - m.t - m.b) : H - m.b - ((y - y0) / (y1 - y0)) * (H - m.t - m.b);

  // 目盛り（控えめな横線）
  const g = el('g', { class: 'axis' }, svg);
  for (const v of niceTicks(y0, y1, 3)) {
    const y = sy(v);
    el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }, g);
    const t = el('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, g);
    t.textContent = opts.yFmt ? opts.yFmt(v) : v;
  }
  for (const v of niceTicks(x0, x1, Math.max(2, Math.floor(W / 80)))) {
    const t = el('text', { x: sx(v), y: H - 6, 'text-anchor': 'middle' }, g);
    t.textContent = opts.xTick ? opts.xTick(v) : opts.xFmt ? opts.xFmt(v) : v;
  }

  const pts = data.filter((d) => d.y != null && isFinite(d.y));
  const line = pts.map((d, i) => `${i ? 'L' : 'M'}${sx(d.x).toFixed(1)},${sy(d.y).toFixed(1)}`).join('');
  if (opts.area) {
    el('path', { d: `${line}L${sx(pts[pts.length - 1].x).toFixed(1)},${H - m.b}L${sx(pts[0].x).toFixed(1)},${H - m.b}Z`, class: 'area' }, svg);
  }
  el('path', { d: line, class: 'line' }, svg);

  // 十字線とツールチップ
  const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4.5, class: 'dot', visibility: 'hidden' }, svg);
  const tip = tooltip(container);
  const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
  const move = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const x = x0 + ((clientX - rect.left) * (W / rect.width) - m.l) / (W - m.l - m.r) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[best].x - x)) best = i;
    const d = pts[best];
    const px = sx(d.x), py = sy(d.y);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    const scale = rect.width / W;
    tip.show(px * scale, py * scale, opts.yFmt ? opts.yFmt(d.y) : d.y, opts.xFmt ? opts.xFmt(d.x) + (opts.xUnit || '') : d.x);
    opts.onHover?.(d);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hide();
    opts.onHover?.(null);
  };
  hit.addEventListener('pointermove', (e) => move(e.clientX));
  hit.addEventListener('pointerdown', (e) => move(e.clientX));
  hit.addEventListener('pointerleave', leave);
  return { leave };
}

/**
 * 縦棒グラフ。data: [{label, value, tip, current}]
 */
export function barChart(container, data, opts = {}) {
  container.replaceChildren();
  container.classList.add('chart');
  const W = container.clientWidth || 320, H = opts.height || 150;
  const m = { l: 34, r: 4, t: 10, b: 22 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || '' }, container);
  const max = Math.max(opts.goal || 0, ...data.map((d) => d.value), 1);
  const ticks = niceTicks(0, max, 3);
  const top = Math.max(max, ticks[ticks.length - 1]);
  const sy = (v) => H - m.b - (v / top) * (H - m.t - m.b);
  const g = el('g', { class: 'axis' }, svg);
  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: 'grid' }, g);
    const t = el('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end' }, g);
    t.textContent = opts.yFmt ? opts.yFmt(v) : v;
  }
  if (opts.goal) {
    el('line', { x1: m.l, x2: W - m.r, y1: sy(opts.goal), y2: sy(opts.goal), class: 'goal' }, svg);
  }
  const bw = (W - m.l - m.r) / data.length;
  const tip = tooltip(container);
  data.forEach((d, i) => {
    const x = m.l + i * bw + 2, w = Math.max(2, bw - 4), h = H - m.b - sy(d.value);
    const r = Math.min(4, w / 2, h);
    const y = sy(d.value);
    if (d.value > 0) {
      el('path', {
        d: `M${x},${H - m.b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - m.b}Z`,
        class: d.current ? 'bar current' : 'bar',
      }, svg);
    }
    if (d.label && (data.length - 1 - i) % Math.ceil(data.length / 6) === 0) {
      const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      t.textContent = d.label;
    }
    const hit = el('rect', { x: m.l + i * bw, y: m.t, width: bw, height: H - m.t - m.b, fill: 'transparent', tabindex: 0 }, svg);
    const show = () => {
      const scale = svg.getBoundingClientRect().width / W;
      tip.show((x + w / 2) * scale, y * scale, opts.yFmt ? opts.yFmt(d.value) + (opts.unit || '') : d.value, d.tip || d.label);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => tip.hide());
    hit.addEventListener('blur', () => tip.hide());
  });
}

/**
 * 月カレンダー。days: その月の日ごとの距離(m)
 */
export function calendar(container, year, month, days, { onPick } = {}) {
  container.replaceChildren();
  container.className = 'calendar';
  const head = ['月', '火', '水', '木', '金', '土', '日'];
  for (const h of head) { const d = document.createElement('div'); d.className = 'cal-h'; d.textContent = h; container.appendChild(d); }
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) container.appendChild(document.createElement('div'));
  const max = Math.max(...days, 1);
  const today = new Date();
  days.forEach((m, i) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'cal-d';
    const level = m <= 0 ? 0 : 1 + Math.min(3, Math.floor((m / max) * 4));
    c.dataset.level = level;
    if (today.getFullYear() === year && today.getMonth() === month && today.getDate() === i + 1) c.classList.add('today');
    c.textContent = i + 1;
    c.setAttribute('aria-label', `${month + 1}月${i + 1}日 ${m > 0 ? (m / 1000).toFixed(1) + 'km' : '記録なし'}`);
    c.title = m > 0 ? `${(m / 1000).toFixed(1)} km` : '';
    if (m > 0 && onPick) c.addEventListener('click', () => onPick(i + 1));
    else c.disabled = m <= 0;
    container.appendChild(c);
  });
}

// 小さなルートのサムネイル（地図なし。一覧用）
export function routeThumb(points, size = 56) {
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'thumb', 'aria-hidden': 'true' });
  if (!points || points.length < 2) return svg;
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLon - minLon) * k || 1e-9, h = maxLat - minLat || 1e-9;
  const s = (size - 8) / Math.max(w, h);
  const ox = (size - w * s) / 2, oy = (size - h * s) / 2;
  const step = Math.max(1, Math.floor(points.length / 150));
  let d = '', lastSeg = null;
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const x = ox + (p[1] - minLon) * k * s, y = size - oy - (p[0] - minLat) * s;
    d += `${p[3] !== lastSeg ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    lastSeg = p[3];
  }
  el('path', { d, class: 'thumb-line' }, svg);
  return svg;
}
