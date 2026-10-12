// 共有用の画像（地図タイルは使わず、ルートの線だけを描く）
import { trimEnds, normalizePoints } from './geo.js';
import { fmtDuration, fmtPace, fmtKm, fmtDate } from './format.js';

export async function renderShareImage(run, { hideMeters = 0, title = '' } = {}) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0f172a'); grad.addColorStop(1, '#1e293b');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);

  const font = (w, s) => `${w} ${s}px -apple-system, "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
  g.fillStyle = '#94a3b8'; g.font = font(500, 36);
  g.fillText(fmtDate(run.startedAt), 72, 110);
  g.fillStyle = '#f8fafc'; g.font = font(700, 54);
  g.fillText(clip(g, title, W - 144), 72, 180);

  // ルート
  const pts = trimEnds(normalizePoints(run.points || []), hideMeters);
  const box = { x: 90, y: 240, w: W - 180, h: 640 };
  if (pts.length > 1) {
    const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const w = (maxLon - minLon) * k || 1e-9, h = maxLat - minLat || 1e-9;
    const s = Math.min(box.w / w, box.h / h);
    const ox = box.x + (box.w - w * s) / 2, oy = box.y + (box.h - h * s) / 2;
    const X = (p) => ox + (p[1] - minLon) * k * s, Y = (p) => oy + (maxLat - p[0]) * s;
    g.lineWidth = 12; g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = '#f97316'; g.shadowColor = 'rgba(249,115,22,.45)'; g.shadowBlur = 24;
    g.beginPath();
    let seg = null;
    for (const p of pts) { if (p[3] !== seg) { g.moveTo(X(p), Y(p)); seg = p[3]; } else g.lineTo(X(p), Y(p)); }
    g.stroke();
    g.shadowBlur = 0;
  }

  // 数値
  const stats = [
    ['距離', `${fmtKm(run.distance)}`, 'km'],
    ['タイム', fmtDuration(run.duration), ''],
    ['ペース', run.distance > 0 ? fmtPace(run.duration / run.distance) : `--'--"`, '/km'],
  ];
  const colW = (W - 144) / 3;
  stats.forEach(([label, value, unit], i) => {
    const x = 72 + i * colW;
    g.fillStyle = '#94a3b8'; g.font = font(500, 34); g.fillText(label, x, 1010);
    g.fillStyle = '#f8fafc'; g.font = font(800, 78); g.fillText(value, x, 1100);
    if (unit) { const vw = g.measureText(value).width; g.fillStyle = '#94a3b8'; g.font = font(500, 32); g.fillText(unit, x + vw + 8, 1100); }
  });
  if (run.elevGain) {
    g.fillStyle = '#94a3b8'; g.font = font(500, 32);
    g.fillText(`獲得標高 ${run.elevGain} m`, 72, 1180);
  }
  g.fillStyle = '#f97316'; g.font = font(800, 40);
  g.fillText('RunLog', 72, H - 72);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

function clip(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
