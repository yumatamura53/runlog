// RunLog 画面とイベントのつなぎ込み
import { Recorder, CONFIG, normalizePoints, paceSeries, splitElevation, smooth, EFFORTS } from './geo.js';
import { Workout, PRESETS, describePlan } from './workout.js';
import {
  weekStart, monthStart, yearStart, sumBetween, weeklySeries, personalRecords, newRecordsIn,
  predictRaces, weekStreak, dailyDistance, shoeMileage,
} from './stats.js';
import { fmtDuration, fmtPace, fmtKm, fmtDate, sayDuration, sayPace, sayKm, parsePace, parseDuration } from './format.js';
import { runs, toGpx, parseGpx, makeBackup, readBackup, shareOrDownload, fileStamp, autoTitle } from './store.js';
import { lineChart, barChart, calendar, routeThumb } from './charts.js';
import { makeMap, drawRoute, hasLeaflet } from './map.js';
import { renderShareImage } from './share.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'runlog.current';
const SETTINGS_KEY = 'runlog.settings';
const GPS_LOST_MS = 15000;

/* ================= 設定 ================= */

const DEFAULTS = {
  voice: true, voiceEvery: 'km1', voicePace: true,
  autopause: false, countdown: true, map: true,
  weekGoal: 20, monthGoal: 80, hideMeters: 200,
  shoes: [], plan: { type: 'free' }, planId: 'free', paceColor: false,
};
const settings = { ...DEFAULTS, ...loadJSON(SETTINGS_KEY) };
function saveSettings() { saveJSON(SETTINGS_KEY, settings); }

function loadJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } }

/* ================= 共通 UI ================= */

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function longPress(btn, ms, label, onDone) {
  btn.replaceChildren();
  const fill = document.createElement('span'); fill.className = 'fill';
  const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = label;
  btn.append(fill, lbl);
  let timer = null;
  const cancel = () => {
    clearTimeout(timer); timer = null;
    fill.style.transition = 'transform .15s'; fill.style.transform = 'scaleX(0)';
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fill.style.transition = `transform ${ms}ms linear`; fill.style.transform = 'scaleX(1)';
    navigator.vibrate?.(10);
    timer = setTimeout(() => { cancel(); navigator.vibrate?.(30); onDone(); }, ms);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // キーボードでは確認ダイアログで代用
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && confirm(`${label.replace('長押しで', '')}しますか？`)) { e.preventDefault(); onDone(); }
  });
}

/* ================= 音声 ================= */

function speak(text, { force = false } = {}) {
  if ((!settings.voice && !force) || !('speechSynthesis' in window) || !text) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* 音声が使えない環境 */ }
}

/* ================= 計測 ================= */

let rec = null;          // Recorder
let workout = null;      // Workout
let voiceState = { half: 0, min: 0 };
let lastFix = null;
let watchId = null;
let wakeLock = null;
let tickTimer = null;
let lastSaved = 0;
let gpsLostWarned = false;

const isRecording = () => rec && rec.status !== 'finished';

function startWatch() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  setGps('searching', 'GPS を探しています…');
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });
}
function restartWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  startWatch();
}

function onGeoError(err) {
  if (err.code === 1) {
    setGps('bad', '位置情報が許可されていません。設定アプリ →（Safari／ブラウザ）→ 位置情報 を「許可」にしてください');
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  } else {
    setGps('searching', 'GPS を探しています…（空が見える場所へ）');
  }
}

function setGps(cls, text) {
  $('gps-status').className = `gps ${cls}`;
  $('gps-text').textContent = text;
}

function onPosition(pos) {
  const c = pos.coords;
  const now = Date.now();
  const fix = {
    lat: c.latitude, lon: c.longitude, acc: c.accuracy,
    alt: c.altitude, altAcc: c.altitudeAccuracy,
    speed: c.speed != null && c.speed >= 0 ? c.speed : null,
    t: now,
  };
  lastFix = fix;
  const q = fix.acc <= 12 ? ['good', '良好'] : fix.acc <= CONFIG.maxAccuracy ? ['fair', 'まずまず'] : ['bad', '弱い'];
  setGps(q[0], `GPS ${q[1]}（誤差 約${Math.round(fix.acc)}m）`);
  updateLiveMarker(fix.lat, fix.lon);

  if (gpsLostWarned && isRecording()) { gpsLostWarned = false; speak('GPS の信号が戻りました'); }
  $('gps-lost').hidden = true;

  if (!isRecording()) return;
  const events = rec.addFix(fix);
  for (const e of events) handleRecorderEvent(e);
  persist(false);
}

function handleRecorderEvent(e) {
  if (e.type === 'point') { appendTrack(); return; }
  if (e.type === 'autopause') { speak('自動一時停止'); render(); }
  if (e.type === 'autoresume') { speak('再開します'); render(); }
  if (e.type === 'split') onSplit(e);
}

function autoCuesEnabled() { return settings.voice && workout?.plan.type !== 'interval'; }

function cueText(distM) {
  const el = rec.elapsed(Date.now());
  let t = `${sayKm(distM)}。タイム ${sayDuration(el)}`;
  if (settings.voicePace && rec.distance > 50) t += `。平均ペース ${sayPace(el / rec.distance)}`;
  return t;
}

function onSplit(e) {
  if (!autoCuesEnabled() || !(settings.voiceEvery === 'km1' || settings.voiceEvery === 'km05')) return;
  let t = `${e.km}キロ。ラップ ${sayDuration(e.lapMs)}`;
  if (settings.voicePace && e.km > 1) t += `。平均ペース ${sayPace(e.totalMs / (e.km * 1000))}`;
  speak(t);
}

function voiceTick(now) {
  if (!autoCuesEnabled() || rec.status !== 'running') return;
  if (settings.voiceEvery === 'km05') {
    const halves = Math.floor(rec.distance / 500);
    if (halves > voiceState.half) {
      voiceState.half = halves;
      if (halves % 2 === 1) speak(cueText(halves * 500)); // ちょうど km の時はラップ案内に任せる
    }
  }
  const every = settings.voiceEvery === 'min5' ? 5 : settings.voiceEvery === 'min10' ? 10 : 0;
  if (every) {
    const mins = Math.floor(rec.elapsed(now) / 60000 / every) * every;
    if (mins > voiceState.min) {
      voiceState.min = mins;
      let t = `${mins}分経過。${sayKm(Math.round(rec.distance / 10) * 10)}`;
      if (settings.voicePace && rec.distance > 50) t += `。平均ペース ${sayPace(rec.elapsed(now) / rec.distance)}`;
      speak(t);
    }
  }
}

async function startFlow() {
  // iOS は操作の直後でないと読み上げが始まらないので、ここで一度話しておく
  if (settings.countdown) {
    const ok = await countdown();
    if (!ok) return;
  } else {
    speak('スタート');
  }
  start();
}

function countdown() {
  return new Promise((resolve) => {
    const ov = $('countdown'), n = $('countdown-n');
    let i = 3, timer;
    ov.hidden = false;
    const step = () => {
      if (i === 0) { ov.hidden = true; speak('スタート'); resolve(true); return; }
      n.textContent = i;
      speak(String(i));
      navigator.vibrate?.(40);
      i--;
      timer = setTimeout(step, 1000);
    };
    $('countdown-cancel').onclick = () => { clearTimeout(timer); ov.hidden = true; speechSynthesis?.cancel(); resolve(false); };
    step();
  });
}

function start() {
  const now = Date.now();
  rec = new Recorder({ autopause: settings.autopause });
  rec.start(now);
  workout = new Workout(settings.plan);
  voiceState = { half: 0, min: 0 };
  gpsLostWarned = false;
  for (const e of workout.intro()) if (e.type === 'say') speak(e.text);
  // スタート直前の測位が新しければ、それを出発点にする
  if (lastFix && now - lastFix.t < 5000) for (const e of rec.addFix({ ...lastFix, t: now })) handleRecorderEvent(e);
  startWatch();
  requestWakeLock();
  resetTrack();
  persist(true);
  startTicking();
  render();
}

function pause() {
  if (!isRecording()) return;
  rec.pause(Date.now());
  persist(true);
  render();
}

function resume() {
  if (!isRecording()) return;
  rec.resume(Date.now(), true);
  persist(true);
  render();
}

async function finish() {
  if (!isRecording()) return;
  const now = Date.now();
  const r = rec.finish(now);
  r.title = autoTitle(r.startedAt);
  r.memo = '';
  const active = settings.shoes.filter((s) => !s.retired);
  if (active.length === 1) r.shoeId = active[0].id;
  if (workout?.steps.length) r.workout = { plan: workout.plan, results: workout.results };
  if (workout?.plan.type === 'interval') r.type = 'インターバル';

  if (r.distance < 50 && !confirm('距離がほとんど記録されていません。保存しますか？\n（キャンセルで破棄）')) {
    clearCurrent();
    render();
    return;
  }
  let saved;
  try {
    saved = await runs.put(r);
  } catch (err) {
    // 保存に失敗しても記録を失わないよう、途中データとして残しておく
    rec.status = 'paused';
    persist(true);
    alert('記録の保存に失敗しました。端末の空き容量を確認して、もう一度「終了」してください。');
    return;
  }
  clearCurrent();
  render();
  const prs = newRecordsIn(saved, await runs.all());
  const prText = prs.length ? `自己ベスト更新。${prs.map((p) => p.label).join('、')}` : '';
  speak(`お疲れさまでした。${sayKm(Math.round(saved.distance / 10) * 10)}、タイム ${sayDuration(saved.duration)}。${prText}`);
  openDetail(saved.id);
}

function discard() {
  if (!isRecording()) return;
  if (!confirm('この計測を記録せずに破棄しますか？')) return;
  clearCurrent();
  render();
  toast('計測を破棄しました');
}

function clearCurrent() {
  rec = null;
  workout = null;
  try { localStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
  stopTicking();
  releaseWakeLock();
  resetTrack();
  setLock(false);
}

function persist(force) {
  const now = Date.now();
  if (!force && now - lastSaved < 5000) return;
  lastSaved = now;
  if (!isRecording()) return;
  const ok = saveJSON(CURRENT_KEY, { rec, workout, voiceState });
  if (!ok && force) toast('途中保存に失敗しました（空き容量不足）');
}

function restoreCurrent() {
  const saved = loadJSON(CURRENT_KEY);
  if (!saved?.rec) return;
  try {
    rec = Recorder.restore(saved.rec);
    workout = saved.workout ? Workout.restore(saved.workout) : new Workout({ type: 'free' });
    voiceState = saved.voiceState || { half: 0, min: 0 };
  } catch {
    try { localStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
    return;
  }
  resetTrack();
  replayTrack();
  startWatch();
  requestWakeLock();
  startTicking();
  toast(rec.status === 'running' ? '計測を続けています（途中から復元しました）' : '一時停止中の計測を復元しました');
}

/* ---- 画面スリープ防止・バックグラウンド復帰 ---- */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 省電力モードなどで拒否されることがある */ }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (isRecording()) {
      requestWakeLock();
      // バックグラウンドから戻ると GPS が止まったままのことがあるので掛け直す
      restartWatch();
    }
    render();
  } else {
    persist(true);
  }
});
window.addEventListener('pagehide', () => persist(true));

/* ---- 1 秒ごとの更新 ---- */

function startTicking() {
  stopTicking();
  tickTimer = setInterval(tick, 1000);
  tick();
}
function stopTicking() { clearInterval(tickTimer); tickTimer = null; }

function tick() {
  if (!isRecording()) return;
  const now = Date.now();
  if (rec.status === 'running') {
    const evs = workout ? workout.update(rec.elapsed(now), rec.distance, rec.currentPace(now)) : [];
    for (const e of evs) if (e.type === 'say') speak(e.text);
    voiceTick(now);
    // GPS 途切れの警告
    const since = now - (lastFix?.t || rec.startedAt);
    if (since > GPS_LOST_MS && document.visibilityState === 'visible') {
      $('gps-lost').hidden = false;
      if (!gpsLostWarned) { gpsLostWarned = true; speak('GPS の信号が途切れています'); }
      if (since > 30000 && since % 30000 < 1000) restartWatch();
    }
  }
  renderMetrics();
}

/* ================= 地図（計測画面） ================= */

let runMap = null, runLines = [], liveMarker = null, followUntil = 0, drawnPoints = 0;

function ensureRunMap() {
  if (runMap || !hasLeaflet()) return;
  runMap = makeMap('map-run');
  if (!runMap) return;
  runMap.setView([35.681, 139.767], 15);
  runMap.on('dragstart', () => { followUntil = Date.now() + 15000; });
}

function resetTrack() {
  runLines.forEach((l) => l.remove());
  runLines = [];
  drawnPoints = 0;
}

function appendTrack() {
  if (!runMap || !rec) return;
  for (; drawnPoints < rec.points.length; drawnPoints++) {
    const p = rec.points[drawnPoints];
    let line = runLines[p[3]];
    if (!line) line = runLines[p[3]] = L.polyline([], { color: '#ea580c', weight: 5 }).addTo(runMap);
    line.addLatLng([p[0], p[1]]);
  }
  const last = rec.points[rec.points.length - 1];
  if (last && Date.now() > followUntil) runMap.panTo([last[0], last[1]], { animate: false });
}
function replayTrack() { drawnPoints = 0; appendTrack(); }

function updateLiveMarker(lat, lon) {
  if (!runMap) return;
  if (!liveMarker) {
    liveMarker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(runMap);
    runMap.setView([lat, lon], 16);
  } else {
    liveMarker.setLatLng([lat, lon]);
    if (!isRecording() && Date.now() > followUntil) runMap.panTo([lat, lon], { animate: false });
  }
}

/* ================= 計測画面の描画 ================= */

function render() {
  const status = rec ? rec.status : 'idle';
  const recording = isRecording();
  $('idle-panel').hidden = recording;
  $('active-panel').hidden = !(status === 'running' || status === 'autopaused');
  $('paused-panel').hidden = status !== 'paused';
  $('btn-pause').textContent = status === 'autopaused' ? '自動一時停止中（タップで再開）' : '一時停止';
  $('btn-pause').classList.toggle('btn-secondary', status === 'autopaused');
  $('btn-pause').classList.toggle('btn-warn', status !== 'autopaused');
  $('run-hint').textContent = recording
    ? (status === 'paused' ? '一時停止中' : '画面ロック中は GPS が止まります。画面はつけたままで')
    : '計測中は画面をつけたままにしてください';
  document.querySelector('.tab[data-view="view-run"]').classList.toggle('recording', recording);
  $('plan-name').textContent = describePlan(settings.plan);
  renderMetrics();
  if (!recording) renderWeekMini();
}

function renderMetrics() {
  const now = Date.now();
  const el = rec ? rec.elapsed(now) : 0;
  const dist = rec ? rec.distance : 0;
  const pace = rec ? rec.currentPace(now) : NaN;
  $('m-distance').textContent = fmtKm(dist);
  $('m-time').textContent = fmtDuration(el);
  $('m-avg').textContent = dist >= 50 ? fmtPace(el / dist) : `--'--"`;
  $('m-pace').textContent = fmtPace(pace);
  // このkmのペース: 直近の km 通過からの平均
  if (rec && dist >= 50) {
    const lastSplit = rec.splits[rec.splits.length - 1] || 0;
    const dKm = dist - rec.splits.length * 1000;
    $('m-lap').textContent = dKm >= 50 ? fmtPace((el - lastSplit) / dKm) : fmtPace((rec.splits[rec.splits.length - 1] - (rec.splits[rec.splits.length - 2] || 0)) / 1000);
    $('m-lap-label').textContent = dKm >= 50 ? `${rec.splits.length + 1}km目のペース` : `${rec.splits.length}km目のラップ`;
  } else {
    $('m-lap').textContent = `--'--"`;
    $('m-lap-label').textContent = 'このkmのペース';
  }
  // ワークアウトの進行
  const v = rec && workout ? workout.view(el, dist) : null;
  $('workout-banner').hidden = !v;
  if (v) {
    $('wb-title').textContent = v.title;
    $('wb-detail').textContent = v.detail;
    $('wb-bar').style.width = `${Math.round(v.progress * 100)}%`;
    $('workout-banner').dataset.kind = v.kind || '';
  }
  if (!$('lock-overlay').hidden) {
    $('l-distance').textContent = fmtKm(dist);
    $('l-time').textContent = fmtDuration(el);
    $('l-pace').textContent = fmtPace(pace);
  }
}

async function renderWeekMini() {
  const all = await runs.all();
  const w = sumBetween(all, weekStart(Date.now()));
  const box = $('week-mini');
  box.replaceChildren();
  const line = document.createElement('div');
  line.textContent = settings.weekGoal > 0
    ? `今週 ${fmtKm(w.dist, 1)} / ${settings.weekGoal} km`
    : `今週 ${fmtKm(w.dist, 1)} km ・ ${w.count} 回`;
  box.appendChild(line);
  if (settings.weekGoal > 0) {
    const bar = document.createElement('div'); bar.className = 'progress';
    const fill = document.createElement('div'); fill.style.width = `${Math.min(100, (w.dist / 1000 / settings.weekGoal) * 100)}%`;
    bar.appendChild(fill); box.appendChild(bar);
  }
}

function setLock(on) {
  $('lock-overlay').hidden = !on;
  if (on) renderMetrics();
}

/* ================= 画面切り替え ================= */

let currentView = 'view-run';
function showView(id, { push = true } = {}) {
  currentView = id;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.tab[data-view]').forEach((t) => {
    const on = t.dataset.view === id || (id === 'view-detail' && t.dataset.view === 'view-history');
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (id === 'view-history') renderHistory();
  if (id === 'view-stats') renderStats();
  if (id === 'view-settings') renderSettings();
  if (id === 'view-run') { render(); setTimeout(() => runMap?.invalidateSize(), 0); }
  if (push) history.pushState({ view: id, detail: detailId }, '');
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', (e) => {
  const v = e.state?.view || 'view-run';
  if (v === 'view-detail' && e.state.detail) openDetail(e.state.detail, { push: false });
  else showView(v, { push: false });
});

/* ================= 記録一覧 ================= */

async function renderHistory() {
  const all = (await runs.all()).slice().sort((a, b) => b.startedAt - a.startedAt);
  $('empty').hidden = all.length > 0;
  const prIds = new Set(Object.values(personalRecords(all)).map((p) => p.runId));
  const list = $('run-list');
  list.replaceChildren();
  let group = null, key = null;
  for (const r of all) {
    const d = new Date(r.startedAt);
    const k = `${d.getFullYear()}-${d.getMonth()}`;
    if (k !== key) {
      key = k;
      const sec = document.createElement('section'); sec.className = 'month-group';
      const h = document.createElement('h2');
      const ms = monthStart(r.startedAt);
      const sum = sumBetween(all, ms, new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime());
      const a = document.createElement('span'); a.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      const b = document.createElement('span'); b.textContent = `${fmtKm(sum.dist, 1)} km ・ ${sum.count} 回`;
      h.append(a, b);
      group = document.createElement('ul'); group.className = 'run-list';
      sec.append(h, group);
      list.appendChild(sec);
    }
    group.appendChild(runItem(r, prIds.has(r.id)));
  }
}

function runItem(r, isPr) {
  const li = document.createElement('li');
  li.className = 'run-item';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  const main = document.createElement('div'); main.className = 'ri-main';
  const title = document.createElement('div'); title.className = 'ri-title'; title.textContent = r.title || autoTitle(r.startedAt);
  if (isPr) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'PB'; b.title = '自己ベストを持つ記録'; title.appendChild(b); }
  const date = document.createElement('div'); date.className = 'ri-date';
  date.textContent = [fmtDate(r.startedAt), r.type, r.manual ? '手入力' : ''].filter(Boolean).join(' ・ ');
  main.append(title, date);
  const right = document.createElement('div');
  const dist = document.createElement('div'); dist.className = 'ri-dist'; dist.textContent = fmtKm(r.distance);
  const unit = document.createElement('small'); unit.textContent = 'km'; dist.appendChild(unit);
  const sub = document.createElement('div'); sub.className = 'ri-sub';
  sub.textContent = `${fmtDuration(r.duration)} ・ ${r.distance > 0 ? fmtPace(r.duration / r.distance) : `--'--"`}`;
  right.append(dist, sub);
  li.append(routeThumb(r.points), main, right);
  li.addEventListener('click', () => openDetail(r.id));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.id); } });
  return li;
}

/* ================= 記録の詳細 ================= */

let detailId = null, detailMap = null, detailLayer = null, hoverMarker = null;

async function openDetail(id, { push = true } = {}) {
  const r = await runs.get(id);
  if (!r) return;
  detailId = id;
  showView('view-detail', { push });
  const all = await runs.all();
  const pts = normalizePoints(r.points || []);

  $('d-title').value = r.title || autoTitle(r.startedAt);
  $('d-date').textContent = `${fmtDate(r.startedAt)}${r.imported ? ' ・ 取り込み' : ''}${r.manual ? ' ・ 手入力' : ''}`;
  $('d-distance').textContent = fmtKm(r.distance);
  $('d-time').textContent = fmtDuration(r.duration);
  $('d-pace').textContent = r.distance > 0 ? fmtPace(r.duration / r.distance) : `--'--"`;
  $('d-elev').textContent = r.elevGain ?? 0;
  $('d-best1k').textContent = r.efforts?.[1000] ? fmtPace(r.efforts[1000]) : '-';
  $('d-elapsed').textContent = r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : '-';
  $('d-gaps').hidden = !r.gaps;
  $('d-gaps').textContent = r.gaps ? `計測中に GPS が途切れた区間が ${r.gaps} か所ありました（画面ロックなど）。その間の距離は直線で補っています。` : '';

  // 自己ベスト
  const prBox = $('d-prs');
  prBox.replaceChildren();
  for (const p of newRecordsIn(r, all)) {
    const c = document.createElement('span'); c.className = 'pr-chip';
    c.textContent = `🏅 ${p.label} 自己ベスト ${fmtDuration(p.sec * 1000)}`;
    prBox.appendChild(c);
  }

  // 地図
  const hasRoute = pts.length > 1 && hasLeaflet();
  $('map-detail').parentElement.hidden = !hasRoute;
  if (hasRoute) drawDetailMap(pts);

  // グラフ
  renderDetailCharts(r, pts);

  // ワークアウト
  const results = r.workout?.results?.filter((x) => x.kind === 'work') || [];
  $('d-workout').hidden = !results.length;
  $('d-workout-rows').replaceChildren(...results.map((x) => row([
    `${x.rep}`, `${Math.round(x.m)} m`, fmtDuration(x.ms), x.m > 50 ? fmtPace(x.ms / x.m) : '-',
  ])));

  renderSplits(r, pts);

  // メモ欄
  $('d-type').value = r.type || '';
  const shoeSel = $('d-shoe');
  shoeSel.replaceChildren(new Option('-', ''), ...settings.shoes.filter((s) => !s.retired || s.id === r.shoeId).map((s) => new Option(s.name, s.id)));
  shoeSel.value = r.shoeId || '';
  $('d-feel').value = r.feel || '';
  $('d-memo').value = r.memo || '';
  $('privacy-hint').textContent = settings.hideMeters > 0 && pts.length
    ? `共有画像と GPX では、スタートとゴール付近 ${settings.hideMeters >= 1000 ? settings.hideMeters / 1000 + 'km' : settings.hideMeters + 'm'} を隠します（設定で変更）`
    : '';
  $('btn-gpx').disabled = !pts.length;
}

function row(cells, cls) {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  for (const c of cells) { const td = document.createElement('td'); if (c instanceof Node) td.appendChild(c); else td.textContent = c; tr.appendChild(td); }
  return tr;
}

let detailPts = [];
function drawDetailMap(pts) {
  detailPts = pts;
  if (!detailMap) {
    detailMap = makeMap('map-detail');
    if (!detailMap) return;
  }
  detailLayer?.remove();
  detailLayer = L.layerGroup().addTo(detailMap);
  const all = drawRoute(detailLayer, pts, { byPace: settings.paceColor });
  $('btn-pacecolor').setAttribute('aria-pressed', String(settings.paceColor));
  $('pace-legend').hidden = !settings.paceColor;
  hoverMarker = null;
  setTimeout(() => {
    detailMap.invalidateSize();
    if (all.length) detailMap.fitBounds(all, { padding: [24, 24] });
  }, 0);
}

function showHover(d) {
  if (!detailMap) return;
  if (!d) { hoverMarker?.remove(); hoverMarker = null; return; }
  // 距離 d.x に一番近い点
  let best = detailPts[0];
  for (const p of detailPts) { if (Math.abs(p[5] - d.x) < Math.abs(best[5] - d.x)) best = p; }
  if (!best) return;
  if (!hoverMarker) hoverMarker = L.circleMarker([best[0], best[1]], { radius: 7, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(detailLayer);
  else hoverMarker.setLatLng([best[0], best[1]]);
}

function renderDetailCharts(r, pts) {
  const total = pts.length ? pts[pts.length - 1][5] : 0;
  const step = total < 3000 ? 50 : total < 15000 ? 100 : 200;
  const series = pts.length > 1 ? paceSeries(pts, step) : [];
  // 信号待ちなどの極端な値でグラフがつぶれないよう、表示範囲を外れ値に強くする
  const paces = series.map((s) => s.pace).filter((p) => isFinite(p) && p > 0).sort((a, b) => a - b);
  const lo = paces[Math.floor(paces.length * 0.03)], hi = paces[Math.floor(paces.length * 0.97)];
  const clamped = series.map((s) => (isFinite(s.pace) ? Math.min(Math.max(s.pace, lo), hi * 1.1) : null));
  const sm = smooth(clamped, series.length > 40 ? 2 : 1);
  const data = series.map((s, i) => ({ x: s.d, y: sm[i] }));
  $('h-pace').hidden = data.length < 2;
  lineChart($('chart-pace'), data, {
    invert: true, minSpan: 30, height: 150, xUnit: ' km 地点',
    xFmt: (x) => (x / 1000).toFixed(x % 1000 ? 1 : 0), xTick: (x) => `${(x / 1000).toFixed(x % 1000 ? 1 : 0)}km`, yFmt: (y) => fmtPace(y),
    onHover: showHover, ariaLabel: `ペースの推移。平均 ${fmtPace(r.duration / Math.max(1, r.distance))}/km`,
  });
  const alts = pts.filter((p) => p[4] != null);
  const hasAlt = alts.length > pts.length * 0.5 && alts.length > 1;
  $('h-elev').hidden = !hasAlt;
  if (hasAlt) {
    const ed = series.filter((s) => s.alt != null).map((s) => ({ x: s.d, y: s.alt }));
    lineChart($('chart-elev'), ed, {
      area: true, minSpan: 10, height: 110, xUnit: ' km 地点',
      xFmt: (x) => (x / 1000).toFixed(x % 1000 ? 1 : 0), xTick: (x) => `${(x / 1000).toFixed(x % 1000 ? 1 : 0)}km`, yFmt: (y) => `${Math.round(y)}m`,
      onHover: showHover, ariaLabel: `標高の推移。獲得標高 ${r.elevGain}m`,
    });
  } else {
    $('chart-elev').hidden = true;
  }
}

function renderSplits(r, pts) {
  const splits = r.splits || [];
  const elev = pts.length ? splitElevation(pts) : [];
  const laps = splits.map((t, i) => ({ label: String(i + 1), sec: (t - (splits[i - 1] || 0)) / 1000, m: 1000 }));
  const rest = r.distance - splits.length * 1000;
  if (rest >= 50 && splits.length < Math.ceil(r.distance / 1000)) {
    laps.push({ label: (rest / 1000).toFixed(2), sec: (r.duration - (splits[splits.length - 1] || 0)) / 1000, m: rest });
  }
  const paceOf = (l) => l.sec / (l.m / 1000);
  const speeds = laps.map((l) => 1 / paceOf(l));
  const maxSpeed = Math.max(...speeds, 1e-9);
  const fastest = laps.length > 1 ? speeds.indexOf(maxSpeed) : -1;
  $('d-splits').replaceChildren(...laps.map((l, i) => {
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.style.width = `${Math.round((speeds[i] / maxSpeed) * 100)}%`;
    const e = elev[i];
    const ev = document.createElement('span'); ev.className = 'elev';
    ev.textContent = e && (e.gain || e.loss) ? `+${e.gain} / -${e.loss}` : '';
    const paceTxt = l.m === 1000 ? fmtPace(l.sec) : `${fmtPace(paceOf(l))}（${fmtDuration(l.sec * 1000)}）`;
    return row([l.label, paceTxt, bar, ev], i === fastest ? 'fastest' : '');
  }));
  $('d-splits').closest('table').hidden = !laps.length;
}

async function updateDetail(patch) {
  const r = await runs.get(detailId);
  if (!r) return;
  await runs.put({ ...r, ...patch });
}

/* ================= 分析 ================= */

let calYear = new Date().getFullYear(), calMonth = new Date().getMonth();

async function renderStats() {
  const all = await runs.all();
  const now = Date.now();
  const week = sumBetween(all, weekStart(now));
  const month = sumBetween(all, monthStart(now));
  goalCard($('goal-week'), '今週', week, settings.weekGoal, `${weekStreak(all, now)} 週連続`);
  const d = new Date(now);
  const daysLeft = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
  goalCard($('goal-month'), '今月', month, settings.monthGoal, settings.monthGoal > 0 && month.dist / 1000 < settings.monthGoal
    ? `残り ${daysLeft} 日で ${(settings.monthGoal - month.dist / 1000).toFixed(1)} km` : `${month.count} 回`);

  const weeks = weeklySeries(all, now, 12);
  barChart($('chart-weeks'), weeks.map((w, i) => {
    const s = new Date(w.start);
    return { label: `${s.getMonth() + 1}/${s.getDate()}`, value: w.dist / 1000, current: i === weeks.length - 1, tip: `${s.getMonth() + 1}/${s.getDate()}〜 ${w.count} 回` };
  }), { goal: settings.weekGoal || 0, yFmt: (v) => (Math.round(v * 10) / 10).toString(), unit: ' km', ariaLabel: '直近 12 週の週ごとの距離' });

  const year = sumBetween(all, yearStart(now));
  $('year-stats').replaceChildren(
    stat(`${fmtKm(year.dist, 0)}`, `${d.getFullYear()}年 km`),
    stat(String(year.count), '回'),
    stat(`${Math.floor(year.time / 3600000)}h${String(Math.floor((year.time % 3600000) / 60000)).padStart(2, '0')}`, '時間'),
    stat(`${year.gain}`, '獲得標高 m'),
  );

  $('cal-title').textContent = `${calYear}年${calMonth + 1}月`;
  const days = dailyDistance(all, calYear, calMonth);
  calendar($('calendar'), calYear, calMonth, days, {
    onPick: (day) => {
      const target = all.filter((r) => { const x = new Date(r.startedAt); return x.getFullYear() === calYear && x.getMonth() === calMonth && x.getDate() === day; });
      if (target.length) openDetail(target.sort((a, b) => b.distance - a.distance)[0].id);
    },
  });

  const prs = personalRecords(all);
  $('pr-rows').replaceChildren(...EFFORTS.map((e) => {
    const p = prs[e.m];
    const tr = row([e.label, p ? fmtDuration(p.sec * 1000) : '-', p ? `${fmtPace(p.sec / (e.m / 1000))}/km` : '', p ? fmtDate(p.date, false) : '']);
    if (p) { tr.className = 'link'; tr.tabIndex = 0; tr.addEventListener('click', () => openDetail(p.runId)); tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openDetail(p.runId); }); }
    return tr;
  }));

  const pred = predictRaces(all, now);
  $('pred-note').textContent = pred
    ? `直近 90 日の ${pred.base.label} ベスト（${fmtDuration(pred.base.sec * 1000)}）から計算した目安です。`
    : '1km 以上走ると表示されます。';
  $('pred-rows').replaceChildren(...(pred ? pred.races.map((r) => row([r.label, fmtDuration(r.sec * 1000), `${fmtPace(r.sec / (r.m / 1000))}/km`])) : []));

  const miles = shoeMileage(all);
  const box = $('shoe-stats');
  box.replaceChildren();
  if (!settings.shoes.length) {
    const p = document.createElement('p'); p.className = 'hint left'; p.textContent = '設定でシューズを登録すると、シューズごとの走行距離が分かります。';
    box.appendChild(p);
  }
  for (const s of settings.shoes) {
    const km = (miles[s.id] || 0) / 1000;
    const wrap = document.createElement('div'); wrap.className = 'shoe-bar';
    const top = document.createElement('div'); top.className = 'row-between';
    const n = document.createElement('span'); n.textContent = s.name + (s.retired ? '（引退）' : '');
    const v = document.createElement('span'); v.textContent = `${km.toFixed(1)} km`;
    top.append(n, v);
    const bar = document.createElement('div'); bar.className = 'progress';
    const fill = document.createElement('div'); fill.style.width = `${Math.min(100, (km / 800) * 100)}%`;
    bar.appendChild(fill);
    wrap.append(top, bar);
    box.appendChild(wrap);
  }
}

function goalCard(elm, label, sum, goal, sub) {
  elm.replaceChildren();
  const k = document.createElement('div'); k.className = 'gk'; k.textContent = goal > 0 ? `${label}（目標 ${goal} km）` : label;
  const v = document.createElement('div'); v.className = 'gv'; v.textContent = fmtKm(sum.dist, 1);
  const u = document.createElement('small'); u.textContent = ' km'; v.appendChild(u);
  elm.append(k, v);
  if (goal > 0) {
    const bar = document.createElement('div'); bar.className = 'progress';
    const fill = document.createElement('div'); fill.style.width = `${Math.min(100, (sum.dist / 1000 / goal) * 100)}%`;
    bar.appendChild(fill); elm.appendChild(bar);
  }
  const s = document.createElement('div'); s.className = 'gs'; s.textContent = sub; elm.appendChild(s);
}

function stat(v, l) {
  const d = document.createElement('div'); d.className = 'stat';
  const a = document.createElement('div'); a.className = 'stat-v'; a.textContent = v;
  const b = document.createElement('div'); b.className = 'stat-l'; b.textContent = l;
  d.append(a, b);
  return d;
}

/* ================= 設定 ================= */

function renderSettings() {
  $('opt-voice').checked = settings.voice;
  $('opt-voiceEvery').value = settings.voiceEvery;
  $('opt-voicePace').checked = settings.voicePace;
  $('opt-autopause').checked = settings.autopause;
  $('opt-countdown').checked = settings.countdown;
  $('opt-map').checked = settings.map;
  $('opt-weekGoal').value = settings.weekGoal || '';
  $('opt-monthGoal').value = settings.monthGoal || '';
  $('opt-hideMeters').value = String(settings.hideMeters);
  renderShoes();
  renderStorageInfo();
}

function renderShoes() {
  $('shoe-list').replaceChildren(...settings.shoes.map((s) => {
    const li = document.createElement('li');
    if (s.retired) li.className = 'retired';
    const n = document.createElement('span'); n.className = 'shoe-n'; n.textContent = s.name;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost small';
    b.textContent = s.retired ? '戻す' : '引退';
    b.addEventListener('click', () => { s.retired = !s.retired; saveSettings(); renderShoes(); });
    li.append(n, b);
    return li;
  }));
}

async function renderStorageInfo() {
  const all = await runs.all();
  let text = `記録 ${all.length} 件`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) text += ` ・ 使用量 ${(est.usage / 1024 / 1024).toFixed(1)} MB`;
    const persisted = await navigator.storage?.persisted?.();
    if (persisted === false) text += ' ・ ブラウザの容量が足りなくなると消える可能性があります。定期的にバックアップしてください。';
  } catch { /* ignore */ }
  $('storage-info').textContent = text;
}

/* ================= メニュー（ワークアウト）選択 ================= */

function openPlanDialog() {
  const grid = $('preset-grid');
  grid.replaceChildren(...PRESETS.map((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset';
    b.setAttribute('aria-pressed', String(settings.planId === p.id));
    const s = document.createElement('strong'); s.textContent = p.name;
    const d = document.createElement('span'); d.textContent = p.plan.type === 'interval' ? describePlan(p.plan) : p.plan.type === 'free' ? '自由に走る' : '目標を音声でお知らせ';
    b.append(s, d);
    b.addEventListener('click', () => { setPlan(p.plan, p.id); $('dlg-plan').close(); });
    return b;
  }));
  $('dlg-plan').showModal();
}

function setPlan(plan, id) {
  settings.plan = plan;
  settings.planId = id;
  saveSettings();
  render();
}

function syncCustomFields() {
  const type = $('cp-type').value;
  document.querySelectorAll('#custom-plan [data-for]').forEach((d) => { d.hidden = d.dataset.for !== type; });
}

function applyCustomPlan() {
  const type = $('cp-type').value;
  const paceText = $('cp-pace').value.trim();
  const pace = paceText ? parsePace(paceText) : null;
  if (paceText && !(pace > 120 && pace < 1200)) { toast('目標ペースは「5:30」の形で入力してください'); return; }
  let plan;
  if (type === 'distance') {
    const km = parseFloat($('cp-dist').value);
    if (!(km > 0)) { toast('距離を入力してください'); return; }
    plan = { type, meters: Math.round(km * 1000) };
  } else if (type === 'time') {
    const min = parseFloat($('cp-time').value);
    if (!(min > 0)) { toast('時間を入力してください'); return; }
    plan = { type, ms: Math.round(min * 60000) };
  } else {
    const work = parseFloat($('cp-work').value), reps = parseInt($('cp-reps').value, 10);
    if (!(work > 0) || !(reps > 0)) { toast('1本の長さと本数を入力してください'); return; }
    plan = {
      type, reps,
      work: $('cp-workUnit').value === 'm' ? { m: Math.round(work) } : { ms: Math.round(work * 1000) },
      restMs: Math.max(0, parseFloat($('cp-rest').value) || 0) * 1000,
      warmupMs: Math.max(0, parseFloat($('cp-warm').value) || 0) * 60000,
      cooldownMs: Math.max(0, parseFloat($('cp-cool').value) || 0) * 60000,
    };
  }
  if (pace) plan.pace = pace;
  setPlan(plan, 'custom');
  $('dlg-plan').close();
}

/* ================= 手入力・取り込み・バックアップ ================= */

function openAddDialog() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  $('add-date').value = d.toISOString().slice(0, 16);
  $('add-dist').value = '';
  $('add-time').value = '';
  $('dlg-add').showModal();
}

async function saveManual() {
  const ts = new Date($('add-date').value).getTime();
  const km = parseFloat($('add-dist').value);
  const ms = parseDuration($('add-time').value);
  if (!isFinite(ts) || !(km > 0) || !(ms > 0)) { toast('日時・距離・タイムを入力してください'); return; }
  if (ms / km < 120000 || ms / km > 1800000) { if (!confirm(`ペースが ${fmtPace(ms / km / 1000)}/km になります。このまま保存しますか？`)) return; }
  let id = ts;
  while (await runs.get(id)) id++;
  const saved = await runs.put({
    v: 2, id, startedAt: ts, endedAt: ts + ms, duration: ms, distance: Math.round(km * 1000),
    splits: [], points: [], elevGain: 0, elevLoss: 0, memo: '', manual: true, title: autoTitle(ts),
  });
  $('dlg-add').close();
  toast('記録を追加しました');
  openDetail(saved.id);
}

async function importGpxFiles(files) {
  let ok = 0, skipped = 0;
  const errors = [];
  const list = [];
  for (const f of files) {
    try {
      const r = parseGpx(await f.text());
      if (await runs.get(r.id) || list.some((x) => x.id === r.id)) { skipped++; continue; }
      r.title ||= autoTitle(r.startedAt);
      list.push(r);
      ok++;
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  if (list.length) await runs.putMany(list);
  const msg = [`${ok} 件取り込みました`, skipped ? `${skipped} 件は取り込み済み` : '', errors.length ? `${errors.length} 件は失敗` : ''].filter(Boolean).join('・');
  toast(msg, 4000);
  if (errors.length) console.warn(errors);
  if (currentView === 'view-history') renderHistory();
}

async function exportBackup() {
  const all = await runs.all();
  const blob = new Blob([makeBackup(all, settings)], { type: 'application/json' });
  const res = await shareOrDownload(blob, `runlog-backup-${fileStamp(Date.now())}.json`);
  if (res !== 'cancelled') { settings.lastBackup = Date.now(); saveSettings(); }
}

async function restoreBackup(file) {
  try {
    const data = readBackup(await file.text());
    if (!confirm(`${data.runs.length} 件の記録を復元します。同じ記録は上書きされます。よろしいですか？`)) return;
    await runs.putMany(data.runs);
    if (data.settings) {
      const shoes = new Map([...settings.shoes, ...(data.settings.shoes || [])].map((s) => [s.id, s]));
      Object.assign(settings, { ...data.settings, shoes: [...shoes.values()] });
      saveSettings();
    }
    toast(`${data.runs.length} 件の記録を復元しました`);
    renderSettings();
  } catch (e) {
    toast(`復元できませんでした: ${e.message}`, 4000);
  }
}

/* ================= イベント登録 ================= */

function bind() {
  $('btn-start').addEventListener('click', startFlow);
  $('btn-pause').addEventListener('click', () => (rec?.status === 'autopaused' ? resume() : pause()));
  $('btn-resume').addEventListener('click', resume);
  longPress($('btn-finish'), 1000, '長押しで終了', finish);
  $('btn-discard').addEventListener('click', discard);
  $('btn-lock').addEventListener('click', () => setLock(true));
  longPress($('btn-unlock'), 800, '長押しで解除', () => setLock(false));
  $('btn-plan').addEventListener('click', openPlanDialog);
  $('cp-type').addEventListener('change', syncCustomFields);
  $('cp-apply').addEventListener('click', applyCustomPlan);
  $('gps-status').addEventListener('click', () => { if (watchId === null) startWatch(); });

  document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  $('btn-back').addEventListener('click', () => showView('view-history'));

  // 詳細
  $('d-title').addEventListener('change', (e) => updateDetail({ title: e.target.value.trim() || autoTitle(Date.now()) }));
  $('d-type').addEventListener('change', (e) => updateDetail({ type: e.target.value }));
  $('d-shoe').addEventListener('change', (e) => updateDetail({ shoeId: e.target.value || null }));
  $('d-feel').addEventListener('change', (e) => updateDetail({ feel: e.target.value }));
  let memoTimer;
  $('d-memo').addEventListener('input', (e) => {
    clearTimeout(memoTimer);
    memoTimer = setTimeout(() => updateDetail({ memo: e.target.value }), 400);
  });
  $('btn-pacecolor').addEventListener('click', () => {
    settings.paceColor = !settings.paceColor; saveSettings();
    if (detailPts.length) drawDetailMap(detailPts);
  });
  $('btn-gpx').addEventListener('click', async () => {
    const r = await runs.get(detailId);
    if (!r) return;
    const blob = new Blob([toGpx(r, { hideMeters: settings.hideMeters })], { type: 'application/gpx+xml' });
    await shareOrDownload(blob, `run-${fileStamp(r.startedAt)}.gpx`);
  });
  $('btn-share').addEventListener('click', async () => {
    const r = await runs.get(detailId);
    if (!r) return;
    const blob = await renderShareImage(r, { hideMeters: settings.hideMeters, title: r.title || autoTitle(r.startedAt) });
    await shareOrDownload(blob, `run-${fileStamp(r.startedAt)}.png`);
  });
  $('btn-delete').addEventListener('click', async () => {
    if (!confirm('この記録を削除しますか？元に戻せません。')) return;
    await runs.del(detailId);
    toast('削除しました');
    showView('view-history');
  });

  // 記録の追加
  $('btn-add').addEventListener('click', openAddDialog);
  $('add-save').addEventListener('click', saveManual);
  $('add-gpx').addEventListener('click', () => { $('dlg-add').close(); $('file-import').click(); });

  // 分析
  $('cal-prev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderStats(); });
  $('cal-next').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderStats(); });

  // 設定
  const bindCheck = (id, key, after) => $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); after?.(); });
  bindCheck('opt-voice', 'voice');
  bindCheck('opt-voicePace', 'voicePace');
  bindCheck('opt-autopause', 'autopause', () => { if (rec) rec.autopause = settings.autopause; });
  bindCheck('opt-countdown', 'countdown');
  bindCheck('opt-map', 'map', applyMapSetting);
  $('opt-voiceEvery').addEventListener('change', (e) => { settings.voiceEvery = e.target.value; saveSettings(); });
  $('opt-weekGoal').addEventListener('change', (e) => { settings.weekGoal = Math.max(0, parseFloat(e.target.value) || 0); saveSettings(); });
  $('opt-monthGoal').addEventListener('change', (e) => { settings.monthGoal = Math.max(0, parseFloat(e.target.value) || 0); saveSettings(); });
  $('opt-hideMeters').addEventListener('change', (e) => { settings.hideMeters = parseInt(e.target.value, 10) || 0; saveSettings(); });
  $('btn-voice-test').addEventListener('click', () => speak(`1キロ。ラップ 5分30秒。平均ペース 5分30秒`, { force: true }));
  $('shoe-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('shoe-name').value.trim();
    if (!name) return;
    settings.shoes.push({ id: `s${Date.now().toString(36)}`, name, retired: false });
    saveSettings();
    $('shoe-name').value = '';
    renderShoes();
  });
  $('btn-backup').addEventListener('click', exportBackup);
  $('btn-restore').addEventListener('click', () => $('file-restore').click());
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-restore').addEventListener('change', (e) => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });
  $('file-import').addEventListener('change', (e) => { if (e.target.files.length) importGpxFiles([...e.target.files]); e.target.value = ''; });

  // 画面の向き・サイズ変更でグラフを描き直す
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentView === 'view-detail' && detailId) runs.get(detailId).then((r) => r && renderDetailCharts(r, normalizePoints(r.points || [])));
      if (currentView === 'view-stats') renderStats();
    }, 200);
  });
}

function applyMapSetting() {
  $('map-run').classList.toggle('hidden', !settings.map || !hasLeaflet());
  if (settings.map) { ensureRunMap(); setTimeout(() => runMap?.invalidateSize(), 0); }
}

/* ================= 起動 ================= */

async function init() {
  bind();
  syncCustomFields();
  applyMapSetting();
  history.replaceState({ view: 'view-run' }, '');
  restoreCurrent();
  render();

  // 位置情報が許可済みなら、スタート前から GPS を温めておく
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    if (perm.state === 'granted' || isRecording()) startWatch();
    else setGps('', 'タップして GPS を開始（スタート時にも開始します）');
  } catch {
    startWatch();
  }

  // バックアップのすすめ（30 日以上していない、かつ記録が 5 件以上）
  const all = await runs.all();
  if (all.length >= 5 && (!settings.lastBackup || Date.now() - settings.lastBackup > 30 * 86400000) && !isRecording()) {
    setTimeout(() => toast('記録はこの端末の中だけにあります。設定 → データ からバックアップしておくと安心です', 5000), 1500);
  }

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
