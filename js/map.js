// Leaflet の地図まわり
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
export const PACE_COLORS = ['#fdba74', '#f97316', '#c2410c', '#7c2d12']; // 遅い → 速い
const LINE = '#ea580c';

export const hasLeaflet = () => typeof window.L !== 'undefined';

export function makeMap(id, { zoomControl = false } = {}) {
  if (!hasLeaflet()) return null;
  const map = L.map(id, { zoomControl, attributionControl: true, zoomSnap: 0.25 });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

function bySegment(points) {
  const segs = new Map();
  for (const p of points) { if (!segs.has(p[3])) segs.set(p[3], []); segs.get(p[3]).push(p); }
  return [...segs.values()];
}

// ルートを描く。byPace=true なら約 50m ごとにペースで 4 段階に色分け
export function drawRoute(group, points, { byPace = false } = {}) {
  const all = points.map((p) => [p[0], p[1]]);
  if (!byPace) {
    for (const seg of bySegment(points)) L.polyline(seg.map((p) => [p[0], p[1]]), { color: LINE, weight: 5, opacity: 0.95 }).addTo(group);
  } else {
    const chunks = [];
    for (const seg of bySegment(points)) {
      let start = 0;
      for (let i = 1; i < seg.length; i++) {
        if (seg[i][5] - seg[start][5] >= 50 || i === seg.length - 1) {
          const dd = seg[i][5] - seg[start][5], dt = seg[i][2] - seg[start][2];
          chunks.push({ pts: seg.slice(start, i + 1), pace: dd > 0 ? dt / dd : Infinity });
          start = i;
        }
      }
    }
    const sorted = chunks.map((c) => c.pace).filter(isFinite).sort((a, b) => a - b);
    const q = (f) => sorted[Math.floor(f * (sorted.length - 1))];
    const cuts = sorted.length ? [q(0.25), q(0.5), q(0.75)] : [];
    for (const c of chunks) {
      // ペースが速い（値が小さい）ほど濃い色
      const level = c.pace <= cuts[0] ? 3 : c.pace <= cuts[1] ? 2 : c.pace <= cuts[2] ? 1 : 0;
      L.polyline(c.pts.map((p) => [p[0], p[1]]), { color: PACE_COLORS[level], weight: 6, opacity: 1 }).addTo(group);
    }
  }
  if (all.length) {
    L.circleMarker(all[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(group);
    L.circleMarker(all[all.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#0f172a', fillOpacity: 1 }).addTo(group);
  }
  return all;
}
