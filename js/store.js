// 保存（IndexedDB）とファイル入出力（GPX・バックアップ）
import { ElevationTracker, haversine, trimEnds, normalizePoints } from './geo.js';
import { computeEfforts } from './stats.js';

/* ---------- IndexedDB ---------- */

let dbPromise = null;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('runlog', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('runs', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const conn = await open();
  return new Promise((resolve, reject) => {
    const t = conn.transaction('runs', mode);
    const req = fn(t.objectStore('runs'));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

let cache = null; // 一覧表示を速くするためのメモリ上の写し

export const runs = {
  async all() {
    if (!cache) cache = (await tx('readonly', (s) => s.getAll())).map(upgrade);
    return cache;
  },
  async get(id) { return (await this.all()).find((r) => r.id === id) || null; },
  async put(run) {
    const r = upgrade(run);
    await tx('readwrite', (s) => s.put(r));
    if (cache) { const i = cache.findIndex((x) => x.id === r.id); if (i >= 0) cache[i] = r; else cache.push(r); }
    return r;
  },
  async putMany(list) {
    const ups = list.map(upgrade);
    await tx('readwrite', (s) => { let last; for (const r of ups) last = s.put(r); return last; });
    cache = null;
  },
  async del(id) {
    await tx('readwrite', (s) => s.delete(id));
    if (cache) cache = cache.filter((r) => r.id !== id);
  },
};

// 古い形式の記録を最新の形にそろえる
export function upgrade(r) {
  if (r.v >= 2 && r.efforts) return r;
  const out = { ...r, v: 2 };
  out.points = normalizePoints(r.points || []);
  out.elevGain ??= 0;
  out.elevLoss ??= 0;
  out.memo ??= '';
  out.efforts = computeEfforts(out);
  return out;
}

export function autoTitle(ts) {
  const h = new Date(ts).getHours();
  const part = h < 4 ? '夜' : h < 10 ? '朝' : h < 15 ? '昼' : h < 18 ? '夕方' : '夜';
  return `${'日月火水木金土'[new Date(ts).getDay()]}曜${part}のラン`;
}

/* ---------- GPX ---------- */

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function toGpx(r, { hideMeters = 0 } = {}) {
  const pts = trimEnds(normalizePoints(r.points || []), hideMeters);
  const segs = new Map();
  for (const p of pts) { if (!segs.has(p[3])) segs.set(p[3], []); segs.get(p[3]).push(p); }
  // 時刻は「実際の時刻」に近づけるため、開始時刻＋経過秒で出す（一時停止分は詰まる）
  const trksegs = [...segs.values()].map((ps) => '  <trkseg>\n' + ps.map(([lat, lon, sec, , alt]) =>
    `   <trkpt lat="${lat}" lon="${lon}">${alt != null ? `<ele>${alt}</ele>` : ''}<time>${new Date(r.startedAt + sec * 1000).toISOString()}</time></trkpt>`).join('\n') + '\n  </trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunLog" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>${new Date(r.startedAt).toISOString()}</time></metadata>
 <trk>
  <name>${esc(r.title || autoTitle(r.startedAt))}</name>
  <type>running</type>${r.memo ? `\n  <desc>${esc(r.memo)}</desc>` : ''}
${trksegs}
 </trk>
</gpx>
`;
}

// GPX を記録に変換する（Strava などから書き出したファイルの取り込み用）
export function parseGpx(text) {
  const nameMatch = text.match(/<trk>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  const samples = [];
  let seg = 0;
  const segRe = /<trkseg[^>]*>([\s\S]*?)<\/trkseg>/g;
  let sm;
  while ((sm = segRe.exec(text))) {
    const ptRe = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
    let pm;
    while ((pm = ptRe.exec(sm[1]))) {
      const attrs = pm[1], body = pm[2] || '';
      const lat = parseFloat((attrs.match(/lat\s*=\s*["']([^"']+)/) || [])[1]);
      const lon = parseFloat((attrs.match(/lon\s*=\s*["']([^"']+)/) || [])[1]);
      const time = Date.parse((body.match(/<time>([^<]+)<\/time>/) || [])[1]);
      const ele = parseFloat((body.match(/<ele>([^<]+)<\/ele>/) || [])[1]);
      if (isFinite(lat) && isFinite(lon)) samples.push({ lat, lon, t: time, alt: isFinite(ele) ? ele : null, seg });
    }
    seg++;
  }
  if (samples.length < 2) throw new Error('GPX に軌跡が見つかりませんでした');
  if (!samples.every((s) => isFinite(s.t))) throw new Error('時刻のない GPX は取り込めません');
  const rec = recordFromSamples(samples);
  const raw = nameMatch && nameMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  if (raw) rec.title = raw;
  return rec;
}

// 時刻つきの点列から、移動時間・距離・ラップ・標高を計算する
export function recordFromSamples(samples) {
  const elev = new ElevationTracker(3);
  const points = [];
  const splits = [];
  let dist = 0, moving = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i - 1];
    const alt = elev.add(s.alt, null);
    if (prev && prev.seg === s.seg) {
      const d = haversine(prev, s);
      const dt = (s.t - prev.t) / 1000;
      // 止まっていた時間・記録が途切れた時間は移動時間に入れない
      if (dt > 0 && dt < 60 && d / dt >= 0.5) {
        const before = dist, beforeT = moving;
        dist += d; moving += dt;
        while (dist >= (splits.length + 1) * 1000) {
          const target = (splits.length + 1) * 1000;
          splits.push(Math.round((beforeT + ((target - before) / d) * dt) * 1000));
        }
      }
    }
    points.push([+s.lat.toFixed(6), +s.lon.toFixed(6), Math.round(moving * 10) / 10, s.seg, alt == null ? null : Math.round(alt * 10) / 10, Math.round(dist * 10) / 10]);
  }
  const startedAt = samples[0].t;
  const rec = {
    v: 2, id: startedAt, startedAt, endedAt: samples[samples.length - 1].t,
    duration: Math.round(moving * 1000), distance: Math.round(dist), splits, points,
    elevGain: Math.round(elev.gain), elevLoss: Math.round(elev.loss), memo: '', imported: true,
  };
  rec.efforts = computeEfforts(rec);
  return rec;
}

/* ---------- バックアップ ---------- */

export function makeBackup(allRuns, settings) {
  return JSON.stringify({ app: 'RunLog', version: 2, exportedAt: new Date().toISOString(), settings, runs: allRuns });
}

export function readBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'RunLog' || !Array.isArray(data.runs)) throw new Error('RunLog のバックアップファイルではありません');
  return { runs: data.runs.map(upgrade), settings: data.settings || null };
}

/* ---------- ファイルを渡す ---------- */

export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

export function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
