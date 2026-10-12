'use strict';

/* ================= 定数・ユーティリティ ================= */

const MAX_ACCURACY_M = 35;      // これより精度の悪い測位は使わない
const MAX_SPEED_MS = 10;        // 36km/h を超える移動は GPS の飛びとして捨てる
const PACE_WINDOW_MS = 20000;   // 現在ペースを計算する時間幅
const AUTOPAUSE_SPEED = 0.6;    // m/s 未満が続いたら止まったとみなす
const AUTOPAUSE_AFTER_MS = 8000;
const AUTORESUME_DIST_M = 12;
const CURRENT_KEY = 'runlog.current';
const SETTINGS_KEY = 'runlog.settings';

const $ = (id) => document.getElementById(id);

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 30 * 60) return `--'--"`;
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
}

function speakDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? h + '時間' : ''}${m ? m + '分' : ''}${sec}秒`;
}

function fmtKm(m) { return (m / 1000).toFixed(2); }

function fmtDate(ts) {
  const d = new Date(ts);
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w}) ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ================= 設定 ================= */

const settings = Object.assign({ voice: true, autopause: false, map: true }, loadJSON(SETTINGS_KEY));

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量不足などは無視 */ }
}

/* ================= IndexedDB（完了したランの保存先） ================= */

const db = {
  _p: null,
  open() {
    if (!this._p) {
      this._p = new Promise((resolve, reject) => {
        const req = indexedDB.open('runlog', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('runs', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this._p;
  },
  async tx(mode, fn) {
    const conn = await this.open();
    return new Promise((resolve, reject) => {
      const t = conn.transaction('runs', mode);
      const result = fn(t.objectStore('runs'));
      t.oncomplete = () => resolve(result.result ?? result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  put(run) { return this.tx('readwrite', (s) => s.put(run)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

/* ================= 計測ロジック ================= */

// status: 'idle' | 'running' | 'paused' | 'autopaused'
let run = null;
let lastFix = null;      // 直近の測位（精度表示・スタート直後の起点用）
let watchId = null;
let wakeLock = null;
let tickTimer = null;
let recent = [];         // 現在ペース計算用 {elapsed, dist}
let rejectStreak = 0;
let lastSaved = 0;

function newRun() {
  return {
    id: Date.now(),
    startedAt: Date.now(),
    status: 'running',
    accumMs: 0,             // 一時停止までに積み上がった時間
    resumedAt: Date.now(),  // 最後に走り始めた時刻
    distance: 0,            // m
    seg: 0,                 // 一時停止ごとに区間を分ける
    anchor: null,           // 最後に採用した地点 {lat, lon, at}
    lastMoveAt: Date.now(),
    splits: [],             // 各kmを通過したときの累計経過ms
    points: [],             // [lat, lon, 経過秒, 区間]
  };
}

function elapsedAt(now = Date.now()) {
  if (!run) return 0;
  return run.accumMs + (run.status === 'running' ? now - run.resumedAt : 0);
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const now = Date.now();
  lastFix = { lat, lon, accuracy, at: now };
  updateGpsStatus(accuracy);
  updateLiveMarker(lat, lon);

  if (!run || run.status === 'paused') return;
  if (accuracy > MAX_ACCURACY_M) return;

  if (run.status === 'autopaused') {
    if (run.anchor && haversine(run.anchor, lastFix) >= AUTORESUME_DIST_M) {
      resume(true);
    } else {
      return;
    }
  }

  const p = { lat, lon, at: now };
  if (!run.anchor) {
    acceptPoint(p, 0);
    return;
  }

  const d = haversine(run.anchor, p);
  const dt = Math.max(0.001, (now - run.anchor.at) / 1000);
  const minMove = Math.max(3, Math.min(accuracy, 20) * 0.5);

  if (d / dt > MAX_SPEED_MS) {
    // 明らかな飛び。連続する場合は起点がおかしかったとみなして起点を付け替える
    if (++rejectStreak >= 5) {
      rejectStreak = 0;
      run.seg++;
      acceptPoint(p, 0);
    }
    return;
  }
  rejectStreak = 0;

  if (d < minMove) {
    maybeAutopause(now);
    return;
  }
  run.lastMoveAt = now;
  acceptPoint(p, d);
}

function acceptPoint(p, d) {
  const el = elapsedAt(p.at);
  const prevDist = run.distance;
  const prevEl = run.anchor && run.anchor.seg === run.seg ? run.anchor.el : el;
  run.distance += d;

  // km 通過時刻を前後の地点から線形補間して記録
  while (run.distance >= (run.splits.length + 1) * 1000) {
    const target = (run.splits.length + 1) * 1000;
    const ratio = d > 0 ? (target - prevDist) / d : 1;
    const t = prevEl + ratio * (el - prevEl);
    run.splits.push(Math.round(t));
    announceSplit();
  }

  run.anchor = { lat: p.lat, lon: p.lon, at: p.at, el, seg: run.seg };
  run.points.push([+p.lat.toFixed(6), +p.lon.toFixed(6), Math.round(el / 1000), run.seg]);
  recent.push({ el, dist: run.distance });
  recent = recent.filter((r) => el - r.el <= PACE_WINDOW_MS);
  appendTrack(p.lat, p.lon);
  persistCurrent(false);
}

function maybeAutopause(now) {
  if (!settings.autopause || run.status !== 'running') return;
  if (now - run.lastMoveAt < AUTOPAUSE_AFTER_MS) return;
  // 止まった時点までさかのぼって時間を止める
  run.accumMs += Math.max(0, run.lastMoveAt - run.resumedAt);
  run.status = 'autopaused';
  recent = [];
  speak('自動一時停止');
  persistCurrent(true);
  render();
}

function currentPace() {
  if (recent.length < 2) return NaN;
  const a = recent[0], b = recent[recent.length - 1];
  const dd = b.dist - a.dist;
  if (dd < 10) return NaN;
  return ((b.el - a.el) / 1000) / (dd / 1000);
}

function startWatch() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
}

function onGeoError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    $('gps-text').textContent = '位置情報が許可されていません（設定アプリから許可してください）';
    $('gps-status').className = 'gps bad';
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  } else {
    $('gps-text').textContent = 'GPS を探しています…';
    $('gps-status').className = 'gps fair';
  }
}

function updateGpsStatus(acc) {
  const cls = acc <= 15 ? 'good' : acc <= MAX_ACCURACY_M ? 'fair' : 'bad';
  const label = cls === 'good' ? '良好' : cls === 'fair' ? 'まずまず' : '弱い';
  $('gps-status').className = `gps ${cls}`;
  $('gps-text').textContent = `GPS ${label}（誤差 約${Math.round(acc)}m）`;
}

/* ---- 操作 ---- */

function start() {
  run = newRun();
  recent = [];
  rejectStreak = 0;
  if (lastFix && lastFix.accuracy <= MAX_ACCURACY_M && Date.now() - lastFix.at < 10000) {
    acceptPoint({ lat: lastFix.lat, lon: lastFix.lon, at: Date.now() }, 0);
  }
  startWatch();
  requestWakeLock();
  speak('計測を開始します');
  resetTrack();
  persistCurrent(true);
  startTicking();
  render();
}

function pause() {
  if (!run || run.status !== 'running') return;
  run.accumMs += Date.now() - run.resumedAt;
  run.status = 'paused';
  persistCurrent(true);
  render();
}

function resume(auto = false) {
  if (!run || run.status === 'running') return;
  run.status = 'running';
  run.resumedAt = Date.now();
  run.lastMoveAt = Date.now();
  recent = [];
  if (!auto) {
    run.seg++;          // 手動の一時停止中に移動した分は距離に含めない
    run.anchor = null;
  }
  if (auto) speak('再開');
  persistCurrent(true);
  render();
}

async function finish() {
  if (!run) return;
  if (run.status === 'running') run.accumMs += Date.now() - run.resumedAt;
  run.status = 'paused';
  const record = {
    id: run.id,
    startedAt: run.startedAt,
    endedAt: Date.now(),
    duration: run.accumMs,
    distance: Math.round(run.distance),
    splits: run.splits,
    points: run.points,
    memo: '',
  };
  let saved = true;
  if (record.distance < 50 && !confirm('距離がほとんど記録されていません。保存しますか？\n（キャンセルで破棄）')) {
    if (!confirm('この計測を破棄しますか？')) { render(); return; }
    saved = false;
  }
  if (saved) await db.put(record);
  run = null;
  localStorage.removeItem(CURRENT_KEY);
  stopTicking();
  releaseWakeLock();
  resetTrack();
  render();
  if (saved) {
    speak(`お疲れさまでした。${(record.distance / 1000).toFixed(2)}キロ`);
    openDetail(record.id);
  }
}

function persistCurrent(force) {
  const now = Date.now();
  if (!force && now - lastSaved < 5000) return;
  lastSaved = now;
  if (run) saveJSON(CURRENT_KEY, run);
}

function restoreCurrent() {
  const saved = loadJSON(CURRENT_KEY);
  if (!saved || !saved.id) return;
  run = saved;
  run.anchor = run.anchor ? { ...run.anchor, seg: run.anchor.seg ?? run.seg } : null;
  resetTrack();
  for (const [lat, lon] of run.points) appendTrack(lat, lon, false);
  startWatch();
  requestWakeLock();
  startTicking();
  toast('途中の計測を復元しました');
}

/* ---- 画面スリープ防止 ---- */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 省電力モードなどで拒否されることがある */ }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (run) requestWakeLock();
    render();
  } else if (run) {
    persistCurrent(true);
  }
});
window.addEventListener('pagehide', () => persistCurrent(true));

/* ---- 音声 ---- */

function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* 音声が使えない環境 */ }
}

function announceSplit() {
  const n = run.splits.length;
  const total = run.splits[n - 1];
  const lap = total - (run.splits[n - 2] || 0);
  speak(`${n}キロ。タイム ${speakDuration(total)}。ラップ ${speakDuration(lap)}`);
}

/* ================= 地図 ================= */

const hasLeaflet = () => typeof window.L !== 'undefined';
let runMap, runLine = [], liveMarker, followUntil = 0;

function ensureRunMap() {
  if (runMap || !hasLeaflet()) return;
  runMap = L.map('map-run', { zoomControl: false, attributionControl: true }).setView([35.681, 139.767], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(runMap);
  runMap.on('dragstart', () => { followUntil = Date.now() + 15000; });
}

function resetTrack() {
  if (!runMap) return;
  runLine.forEach((l) => l.remove());
  runLine = [];
}

function appendTrack(lat, lon, follow = true) {
  if (!runMap || !run) return;
  const seg = run.points.length ? run.points[run.points.length - 1][3] : 0;
  let line = runLine[seg];
  if (!line) {
    line = runLine[seg] = L.polyline([], { color: '#f97316', weight: 5 }).addTo(runMap);
  }
  line.addLatLng([lat, lon]);
  if (follow && Date.now() > followUntil) runMap.panTo([lat, lon], { animate: false });
}

function updateLiveMarker(lat, lon) {
  if (!runMap) return;
  if (!liveMarker) {
    liveMarker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(runMap);
    runMap.setView([lat, lon], 16);
  } else {
    liveMarker.setLatLng([lat, lon]);
    if (!run && Date.now() > followUntil) runMap.panTo([lat, lon], { animate: false });
  }
}

let detailMap, detailLayer;
function drawDetailMap(points) {
  if (!hasLeaflet()) { $('map-detail').classList.add('hidden'); return; }
  if (!detailMap) {
    detailMap = L.map('map-detail', { zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(detailMap);
  }
  if (detailLayer) detailLayer.remove();
  detailLayer = L.layerGroup().addTo(detailMap);
  const segs = {};
  for (const [lat, lon, , seg] of points) (segs[seg] ||= []).push([lat, lon]);
  const all = [];
  Object.values(segs).forEach((ll) => { L.polyline(ll, { color: '#f97316', weight: 5 }).addTo(detailLayer); all.push(...ll); });
  setTimeout(() => {
    detailMap.invalidateSize();
    if (all.length) {
      L.circleMarker(all[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(detailLayer);
      L.circleMarker(all[all.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 }).addTo(detailLayer);
      detailMap.fitBounds(all, { padding: [24, 24] });
    } else {
      detailMap.setView([35.681, 139.767], 12);
    }
  }, 0);
}

/* ================= 画面描画 ================= */

function render() {
  const status = run ? run.status : 'idle';
  $('btn-start').hidden = status !== 'idle';
  $('btn-pause').hidden = status !== 'running' && status !== 'autopaused';
  $('btn-pause').textContent = status === 'autopaused' ? '自動一時停止中' : '一時停止';
  $('btn-resume').hidden = status !== 'paused';
  $('btn-finish').hidden = status !== 'paused';
  $('run-hint').textContent = status === 'idle'
    ? '計測中は画面をつけたままにしてください（自動でスリープを防ぎます）'
    : status === 'paused' ? '一時停止中' : '計測中';
  renderMetrics();
}

function renderMetrics() {
  const el = elapsedAt();
  const dist = run ? run.distance : 0;
  $('m-distance').textContent = fmtKm(dist);
  $('m-time').textContent = fmtDuration(el);
  $('m-avg').textContent = dist >= 50 ? fmtPace(el / 1000 / (dist / 1000)) : `--'--"`;
  $('m-pace').textContent = run && run.status === 'running' ? fmtPace(currentPace()) : `--'--"`;
  const s = run ? run.splits : [];
  $('m-lap').textContent = s.length ? fmtPace((s[s.length - 1] - (s[s.length - 2] || 0)) / 1000) : `--'--"`;
}

function startTicking() {
  stopTicking();
  tickTimer = setInterval(renderMetrics, 500);
}
function stopTicking() { clearInterval(tickTimer); }

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.tab[data-view]').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === id || (id === 'view-detail' && t.dataset.view === 'view-history')));
  if (id === 'view-history') renderHistory();
  if (id === 'view-run' && runMap) setTimeout(() => runMap.invalidateSize(), 0);
  window.scrollTo(0, 0);
}

async function renderHistory() {
  const runs = (await db.all()).sort((a, b) => b.startedAt - a.startedAt);
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sum = (from) => runs.filter((r) => r.startedAt >= from.getTime()).reduce((a, r) => a + r.distance, 0);
  $('s-week').textContent = (sum(monday) / 1000).toFixed(1);
  $('s-month').textContent = (sum(monthStart) / 1000).toFixed(1);
  $('s-total').textContent = runs.length;
  $('empty').hidden = runs.length > 0;

  const list = $('run-list');
  list.replaceChildren(...runs.map((r) => {
    const li = document.createElement('li');
    li.className = 'run-item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const pace = r.distance > 0 ? fmtPace(r.duration / 1000 / (r.distance / 1000)) : `--'--"`;
    li.innerHTML = `<div class="ri-date"></div><div></div><div class="ri-dist"></div><div class="ri-sub"></div>`;
    li.children[0].textContent = fmtDate(r.startedAt) + (r.memo ? ` ・ ${r.memo}` : '');
    li.children[2].textContent = `${fmtKm(r.distance)} km`;
    li.children[3].textContent = `${fmtDuration(r.duration)} ・ ${pace}/km`;
    li.addEventListener('click', () => openDetail(r.id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.id); } });
    return li;
  }));
}

let detailId = null;
async function openDetail(id) {
  const r = await db.get(id);
  if (!r) return;
  detailId = id;
  showView('view-detail');
  $('d-date').textContent = fmtDate(r.startedAt);
  $('d-distance').textContent = fmtKm(r.distance);
  $('d-time').textContent = fmtDuration(r.duration);
  $('d-pace').textContent = r.distance > 0 ? fmtPace(r.duration / 1000 / (r.distance / 1000)) : `--'--"`;
  $('d-memo').value = r.memo || '';

  const laps = r.splits.map((t, i) => ({ label: String(i + 1), sec: (t - (r.splits[i - 1] || 0)) / 1000, pace: null }));
  const restM = r.distance - r.splits.length * 1000;
  if (restM >= 50) {
    const sec = (r.duration - (r.splits[r.splits.length - 1] || 0)) / 1000;
    laps.push({ label: (restM / 1000).toFixed(2), sec, pace: sec / (restM / 1000) });
  }
  const paceOf = (l) => l.pace ?? l.sec;
  const max = Math.max(...laps.map(paceOf), 1);
  $('d-splits').replaceChildren(...laps.map((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td><div class="bar"></div></td>';
    tr.children[0].textContent = l.label;
    tr.children[1].textContent = l.pace ? `${fmtDuration(l.sec * 1000)}（${fmtPace(l.pace)}/km）` : fmtPace(l.sec);
    tr.querySelector('.bar').style.width = `${(paceOf(l) / max) * 100}%`;
    return tr;
  }));
  drawDetailMap(r.points);
}

/* ================= GPX 書き出し ================= */

function toGpx(r) {
  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const segs = {};
  for (const p of r.points) (segs[p[3]] ||= []).push(p);
  const trksegs = Object.values(segs).map((ps) => '<trkseg>\n' + ps.map(([lat, lon, sec]) =>
    `<trkpt lat="${lat}" lon="${lon}"><time>${new Date(r.startedAt + sec * 1000).toISOString()}</time></trkpt>`).join('\n') + '\n</trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunLog" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><time>${new Date(r.startedAt).toISOString()}</time></metadata>
<trk><name>${esc(fmtDate(r.startedAt))}</name><type>running</type>${r.memo ? `<desc>${esc(r.memo)}</desc>` : ''}
${trksegs}
</trk>
</gpx>
`;
}

async function exportGpx() {
  const r = await db.get(detailId);
  if (!r) return;
  const d = new Date(r.startedAt);
  const name = `run-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.gpx`;
  const file = new File([toGpx(r)], name, { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ================= イベント ================= */

function setupLongPress(btn, ms, onDone) {
  btn.innerHTML = '<div class="fill"></div><span></span>';
  const label = btn.querySelector('span');
  const fill = btn.querySelector('.fill');
  label.textContent = '長押しで終了';
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    fill.style.transition = 'transform .15s';
    fill.style.transform = 'scaleX(0)';
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fill.style.transition = `transform ${ms}ms linear`;
    fill.style.transform = 'scaleX(1)';
    timer = setTimeout(() => { cancel(); onDone(); }, ms);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && confirm('ランを終了して保存しますか？')) { e.preventDefault(); onDone(); }
  });
}

function bindEvents() {
  $('btn-start').addEventListener('click', start);
  $('btn-pause').addEventListener('click', () => (run.status === 'autopaused' ? resume(false) : pause()));
  $('btn-resume').addEventListener('click', () => resume(false));
  setupLongPress($('btn-finish'), 1000, finish);

  document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  $('btn-back').addEventListener('click', () => showView('view-history'));
  $('btn-gpx').addEventListener('click', exportGpx);
  $('btn-delete').addEventListener('click', async () => {
    if (!confirm('この記録を削除しますか？元に戻せません。')) return;
    await db.del(detailId);
    showView('view-history');
  });
  let memoTimer;
  $('d-memo').addEventListener('input', () => {
    clearTimeout(memoTimer);
    memoTimer = setTimeout(async () => {
      const r = await db.get(detailId);
      if (r) { r.memo = $('d-memo').value.trim(); await db.put(r); }
    }, 400);
  });

  const dlg = $('settings');
  $('btn-settings').addEventListener('click', () => {
    $('opt-voice').checked = settings.voice;
    $('opt-autopause').checked = settings.autopause;
    $('opt-map').checked = settings.map;
    dlg.showModal();
  });
  ['voice', 'autopause', 'map'].forEach((k) => $(`opt-${k}`).addEventListener('change', (e) => {
    settings[k] = e.target.checked;
    saveJSON(SETTINGS_KEY, settings);
    if (k === 'map') applyMapSetting();
  }));

  $('gps-status').addEventListener('click', startWatch);
}

function applyMapSetting() {
  $('map-run').classList.toggle('hidden', !settings.map);
  if (settings.map) { ensureRunMap(); setTimeout(() => runMap && runMap.invalidateSize(), 0); }
}

async function init() {
  bindEvents();
  applyMapSetting();
  if (!hasLeaflet()) $('map-run').classList.add('hidden');
  restoreCurrent();
  render();

  // すでに位置情報が許可済みなら、スタート前から GPS を温めておく
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    if (perm.state === 'granted') startWatch();
    else $('gps-text').textContent = 'タップして GPS を開始';
  } catch {
    startWatch();
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
