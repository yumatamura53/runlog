// GPS の測位から距離・ペース・標高・ラップを計算する部分。
// DOM に依存しない純粋なロジックなので、Node のテストでそのまま検証できる。

export const CONFIG = {
  maxAccuracy: 30,        // m。これより悪い測位は距離計算に使わない
  maxSpeed: 9,            // m/s（約 2'00"/km）。これを超える移動は GPS の飛び
  kalmanQ: 3,             // m/s。カルマンフィルタの想定加速度（走る速さの変化しやすさ）
  minMove: 2,             // m。これ未満の移動は揺れとみなして足さない
  gapMs: 15000,           // これ以上測位が空いたら「途切れ」とみなす
  paceWindowMs: 15000,    // 現在ペースを出す時間幅
  autopauseSpeed: 0.7,    // m/s 未満が続いたら止まったとみなす
  autopauseAfterMs: 6000,
  autoresumeSpeed: 1.2,
  autoresumeDist: 10,
  elevThreshold: 5,       // m。標高差がこれを超えてはじめて上り下りに数える
  dopplerWeight: 0.7,     // 距離に使う「GPS速度×時間」の割合（残りは位置の移動量）
};

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 位置のぶれをならすカルマンフィルタ（等速ではなく「位置＋ばらつき」の単純なモデル）
export class KalmanLatLon {
  constructor(q = CONFIG.kalmanQ) { this.q = q; this.variance = -1; }
  reset() { this.variance = -1; }
  process(lat, lon, accuracy, t) {
    const acc = Math.max(accuracy, 1);
    if (this.variance < 0) {
      this.lat = lat; this.lon = lon; this.t = t; this.variance = acc * acc;
      return { lat, lon };
    }
    const dt = (t - this.t) / 1000;
    if (dt > 0) { this.variance += dt * this.q * this.q; this.t = t; }
    const k = this.variance / (this.variance + acc * acc);
    this.lat += k * (lat - this.lat);
    this.lon += k * (lon - this.lon);
    this.variance = (1 - k) * this.variance;
    return { lat: this.lat, lon: this.lon };
  }
}

// 標高: GPS の高度は揺れが大きいので、なめらかにしたうえで閾値を超えた分だけ数える
export class ElevationTracker {
  constructor(threshold = CONFIG.elevThreshold) {
    this.threshold = threshold; this.smoothed = null; this.ref = null; this.gain = 0; this.loss = 0;
  }
  add(alt, altAcc) {
    if (alt == null || !isFinite(alt) || (altAcc != null && altAcc > 25)) return this.smoothed;
    this.smoothed = this.smoothed == null ? alt : this.smoothed + 0.25 * (alt - this.smoothed);
    if (this.ref == null) this.ref = this.smoothed;
    const diff = this.smoothed - this.ref;
    if (diff >= this.threshold) { this.gain += diff; this.ref = this.smoothed; }
    else if (diff <= -this.threshold) { this.loss -= diff; this.ref = this.smoothed; }
    return this.smoothed;
  }
  toJSON() { return { smoothed: this.smoothed, ref: this.ref, gain: this.gain, loss: this.loss }; }
  static from(o, threshold) { return Object.assign(new ElevationTracker(threshold), o || {}); }
}

/*
 * 1 回のランを記録するクラス。時刻はすべて引数で受け取る（テストしやすくするため）。
 * points: [緯度, 経度, 経過秒, 区間番号, 標高(m|null), 累計距離(m)]
 */
export class Recorder {
  constructor(opts = {}) {
    this.autopause = !!opts.autopause;
    this.status = 'idle';         // idle | running | paused | autopaused | finished
    this.distance = 0;
    this.accumMs = 0;
    this.resumedAt = 0;
    this.startedAt = 0;
    this.seg = 0;
    this.splits = [];             // 各 km 通過時の累計経過 ms
    this.points = [];
    this.anchor = null;           // 最後に距離計算に採用した地点
    this.lastMoveAt = 0;
    this.gaps = 0;                // 測位が途切れた回数（画面オフなど）
    this.rejectStreak = 0;
    this.recentSpeeds = [];       // [{t, v}] GPS のドップラー速度
    this.recentDist = [];         // [{el, dist}] 位置から計算した距離
    this.kalman = new KalmanLatLon();
    this.elev = new ElevationTracker();
    this.lastFixAt = 0;
  }

  start(now) {
    this.status = 'running';
    this.startedAt = now;
    this.resumedAt = now;
    this.lastMoveAt = now;
  }

  elapsed(now) {
    return this.accumMs + (this.status === 'running' ? Math.max(0, now - this.resumedAt) : 0);
  }

  pause(now) {
    if (this.status === 'running') this.accumMs += now - this.resumedAt;
    this.status = 'paused';
  }

  // manual=true のときは一時停止中の移動を距離に含めない
  resume(now, manual = true) {
    if (this.status === 'running' || this.status === 'finished') return;
    this.status = 'running';
    this.resumedAt = now;
    this.lastMoveAt = now;
    this.recentSpeeds = [];
    this.recentDist = [];
    if (manual) { this.seg++; this.anchor = null; this.kalman.reset(); }
  }

  /**
   * 測位を 1 件取り込む。fix = {lat, lon, acc, alt, altAcc, speed, t}
   * 戻り値は画面・音声に伝えるイベントの配列。
   */
  addFix(fix) {
    const events = [];
    if (this.status === 'idle' || this.status === 'paused' || this.status === 'finished') return events;
    if (!(fix.acc <= CONFIG.maxAccuracy)) return events;

    const t = fix.t;
    const gap = this.lastFixAt && t - this.lastFixAt > CONFIG.gapMs;
    this.lastFixAt = t;
    if (gap) { this.gaps++; this.kalman.reset(); }

    if (fix.speed != null && fix.speed >= 0 && isFinite(fix.speed)) {
      this.recentSpeeds.push({ t, v: fix.speed });
      this.recentSpeeds = this.recentSpeeds.filter((s) => t - s.t <= CONFIG.paceWindowMs);
    }

    // 自動一時停止からの復帰判定
    if (this.status === 'autopaused') {
      const moving = (fix.speed != null && fix.speed >= CONFIG.autoresumeSpeed)
        || (this.anchor && haversine(this.anchor, fix) - fix.acc / 2 >= CONFIG.autoresumeDist);
      if (!moving) return events;
      this.status = 'running';
      this.resumedAt = t;
      this.lastMoveAt = t;
      this.kalman.reset();
      events.push({ type: 'autoresume' });
    }

    // 明らかな飛びを捨てる（誤差分は割り引いて判定）
    if (this.anchor && this.anchor.seg === this.seg) {
      const dt = Math.max(1, t - this.anchor.t) / 1000;
      const raw = haversine(this.anchor, fix);
      if ((raw - fix.acc) / dt > CONFIG.maxSpeed) {
        if (++this.rejectStreak < 5) return events;
        // 飛びが続く＝起点のほうがおかしかった。区間を切って付け替える
        this.seg++;
        this.kalman.reset();
      }
    }
    this.rejectStreak = 0;

    const f = this.kalman.process(fix.lat, fix.lon, fix.acc, t);
    const alt = this.elev.add(fix.alt, fix.altAcc);
    const p = { lat: f.lat, lon: f.lon, t, seg: this.seg, alt };

    if (!this.anchor || this.anchor.seg !== this.seg) {
      this._accept(p, 0, events);
      return events;
    }

    let d = haversine(this.anchor, p);
    const v = this._dopplerSpeed(t);
    // 止まっている（GPS の速度がほぼ 0）なら、位置の揺れは距離に足さない
    const still = v != null && v < 0.8 && !gap;
    if (d < CONFIG.minMove || (still && d < Math.max(15, fix.acc * 2))) {
      this._maybeAutopause(t, events);
      return events;
    }
    // GPS の速度（ドップラー）が取れるときは「速度×時間」と位置の移動量を 7:3 で混ぜる。
    // 速度は位置の左右の揺れに強く、位置は端末ごとの速度のくせに強いので、互いの弱点を打ち消す
    // （合成データでの検証は tests/accuracy.mjs）。両者が大きく食い違うときは位置を信じる。
    if (v != null && !gap) {
      const dt = (t - this.anchor.t) / 1000;
      const dv = v * dt;
      if (Math.abs(dv - d) <= Math.max(5, d * 0.5)) {
        const w = CONFIG.dopplerWeight;
        d = w * dv + (1 - w) * d;
      }
    }
    if (v == null || v >= CONFIG.autopauseSpeed) this.lastMoveAt = t;
    else this._maybeAutopause(t, events);
    if (this.status !== 'running') return events;
    this._accept(p, d, events);
    return events;
  }

  // 直近数秒の GPS 速度の平均（取れなければ null）
  _dopplerSpeed(t) {
    const recent = this.recentSpeeds.filter((s) => t - s.t <= 4000);
    if (recent.length < 2) return null;
    return recent.reduce((a, s) => a + s.v, 0) / recent.length;
  }

  _maybeAutopause(t, events) {
    if (!this.autopause || this.status !== 'running') return;
    if (t - this.lastMoveAt < CONFIG.autopauseAfterMs) return;
    // 止まった時点までさかのぼって時計を止める
    this.accumMs += Math.max(0, this.lastMoveAt - this.resumedAt);
    this.status = 'autopaused';
    this.recentSpeeds = [];
    this.recentDist = [];
    events.push({ type: 'autopause' });
  }

  _accept(p, d, events) {
    const el = this.elapsed(p.t);
    const prevDist = this.distance;
    const prevEl = this.anchor && this.anchor.seg === p.seg ? this.anchor.el : el;
    this.distance += d;

    while (this.distance >= (this.splits.length + 1) * 1000) {
      const target = (this.splits.length + 1) * 1000;
      const ratio = d > 0 ? (target - prevDist) / d : 1;
      const at = Math.round(prevEl + ratio * (el - prevEl));
      this.splits.push(at);
      const n = this.splits.length;
      events.push({ type: 'split', km: n, totalMs: at, lapMs: at - (this.splits[n - 2] || 0) });
    }

    this.anchor = { lat: p.lat, lon: p.lon, t: p.t, el, seg: p.seg };
    this.points.push([
      +p.lat.toFixed(6), +p.lon.toFixed(6), Math.round(el / 100) / 10, p.seg,
      p.alt == null ? null : Math.round(p.alt * 10) / 10, Math.round(this.distance * 10) / 10,
    ]);
    this.recentDist.push({ el, dist: this.distance });
    this.recentDist = this.recentDist.filter((r) => el - r.el <= CONFIG.paceWindowMs);
    events.push({ type: 'point' });
  }

  // 現在ペース（秒/km）。GPS のドップラー速度があればそれを優先する
  currentPace(now) {
    if (this.status !== 'running') return NaN;
    const speeds = this.recentSpeeds.filter((s) => now - s.t <= CONFIG.paceWindowMs);
    if (speeds.length >= 3) {
      const v = speeds.reduce((a, s) => a + s.v, 0) / speeds.length;
      return v > 0.5 ? 1000 / v : NaN;
    }
    const r = this.recentDist;
    if (r.length < 2) return NaN;
    const dd = r[r.length - 1].dist - r[0].dist;
    if (dd < 10) return NaN;
    return (r[r.length - 1].el - r[0].el) / dd; // ms/m = 秒/km
  }

  finish(now) {
    if (this.status === 'running') this.accumMs += now - this.resumedAt;
    this.status = 'finished';
    return {
      v: 2,
      id: this.startedAt,
      startedAt: this.startedAt,
      endedAt: now,
      duration: this.accumMs,
      distance: Math.round(this.distance),
      splits: this.splits,
      points: this.points,
      elevGain: Math.round(this.elev.gain),
      elevLoss: Math.round(this.elev.loss),
      gaps: this.gaps,
    };
  }

  toJSON() {
    const { kalman, elev, ...rest } = this;
    return { ...rest, elev: elev.toJSON() };
  }

  static restore(o) {
    const r = new Recorder();
    Object.assign(r, o);
    r.kalman = new KalmanLatLon();
    r.elev = ElevationTracker.from(o.elev);
    r.recentSpeeds = [];
    r.recentDist = [];
    return r;
  }
}

/* ---------- 記録の分析 ---------- */

// 旧形式（v1: [lat, lon, 秒, 区間]）の points に累計距離を補う
export function normalizePoints(points) {
  if (!points.length || points[0].length >= 6) return points;
  let dist = 0;
  return points.map((p, i) => {
    const prev = points[i - 1];
    if (prev && prev[3] === p[3]) dist += haversine({ lat: prev[0], lon: prev[1] }, { lat: p[0], lon: p[1] });
    return [p[0], p[1], p[2], p[3], null, Math.round(dist * 10) / 10];
  });
}

// 指定距離をいちばん速く走れた区間（秒）。届かなければ null
export function bestEffort(points, meters) {
  const n = points.length;
  if (!n || points[n - 1][5] < meters) return null;
  let best = Infinity;
  let i = 0;
  for (let j = 1; j < n; j++) {
    const dj = points[j][5];
    while (i + 1 < j && dj - points[i + 1][5] >= meters) i++;
    const di = points[i][5];
    if (dj - di < meters) continue;
    // 区間の端を目標距離ぴったりに補間する
    const pj1 = points[j - 1];
    const over = dj - di - meters;
    const segLen = dj - pj1[5];
    const tj = segLen > 0 ? points[j][2] - (over / segLen) * (points[j][2] - pj1[2]) : points[j][2];
    const t = Math.max(0, tj - points[i][2]);
    if (t < best) best = t;
  }
  return isFinite(best) ? best : null;
}

export const EFFORTS = [
  { m: 1000, label: '1km' },
  { m: 5000, label: '5km' },
  { m: 10000, label: '10km' },
  { m: 21097.5, label: 'ハーフ' },
  { m: 42195, label: 'フル' },
];

// 距離ごとのペース推移（グラフ用）。step m ごとに平均ペース(秒/km)と標高を出す
export function paceSeries(points, step = 100) {
  const out = [];
  if (points.length < 2) return out;
  let i = 0;
  for (let d = step; d <= points[points.length - 1][5]; d += step) {
    while (i < points.length - 1 && points[i + 1][5] < d) i++;
    const a = timeAt(points, d - step), b = timeAt(points, d);
    const alt = points[Math.min(i + 1, points.length - 1)][4];
    out.push({ d, pace: (b - a) / (step / 1000), alt });
  }
  return out;
}

function timeAt(points, d) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid][5] < d) lo = mid + 1; else hi = mid; }
  const b = points[lo], a = points[Math.max(0, lo - 1)];
  if (b[5] === a[5]) return b[2];
  return a[2] + ((d - a[5]) / (b[5] - a[5])) * (b[2] - a[2]);
}

// km ごとの標高の上り下り（揺れを数えないよう、閾値を超えた変化だけを数える）
export function splitElevation(points, threshold = 3) {
  const out = [{ gain: 0, loss: 0 }];
  let ref = null;
  for (const p of points) {
    const km = Math.floor(p[5] / 1000);
    while (out.length <= km) out.push({ gain: 0, loss: 0 });
    if (p[4] == null) continue;
    if (ref == null) { ref = p[4]; continue; }
    const diff = p[4] - ref;
    if (diff >= threshold) { out[km].gain += diff; ref = p[4]; }
    else if (diff <= -threshold) { out[km].loss -= diff; ref = p[4]; }
  }
  return out.map((e) => ({ gain: Math.round(e.gain), loss: Math.round(e.loss) }));
}

// グラフ用の移動平均（null は飛ばす）
export function smooth(values, radius = 2) {
  return values.map((v, i) => {
    if (v == null) return null;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      if (values[j] != null && isFinite(values[j])) { sum += values[j]; n++; }
    }
    return n ? sum / n : v;
  });
}

// プライバシー: スタート・ゴール付近 meters を取り除いた points
export function trimEnds(points, meters) {
  if (!meters || points.length < 2) return points;
  const total = points[points.length - 1][5];
  if (total <= meters * 2) return [];
  return points.filter((p) => p[5] >= meters && p[5] <= total - meters);
}
