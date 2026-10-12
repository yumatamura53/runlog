// 記録全体の集計（週・月の合計、自己ベスト、レース予想、連続記録）
import { EFFORTS, bestEffort, normalizePoints } from './geo.js';

const DAY = 86400000;

export function weekStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}
export function monthStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
export function yearStart(ts) {
  return new Date(new Date(ts).getFullYear(), 0, 1).getTime();
}

export function sumBetween(runs, from, to = Infinity) {
  let dist = 0, time = 0, count = 0, gain = 0;
  for (const r of runs) {
    if (r.startedAt >= from && r.startedAt < to) { dist += r.distance; time += r.duration; count++; gain += r.elevGain || 0; }
  }
  return { dist, time, count, gain };
}

// 直近 n 週の週ごとの合計（古い順）
export function weeklySeries(runs, now, n = 12) {
  const starts = [];
  let s = weekStart(now);
  for (let i = 0; i < n; i++) { starts.unshift(s); s = weekStart(s - DAY); }
  return starts.map((start, i) => ({ start, ...sumBetween(runs, start, starts[i + 1] ?? Infinity) }));
}

// 今年の月ごとの合計
export function monthlySeries(runs, now) {
  const y = new Date(now).getFullYear();
  return Array.from({ length: 12 }, (_, m) => ({
    month: m + 1,
    ...sumBetween(runs, new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()),
  }));
}

// 1 回のランのベストエフォート（保存時に計算しておく）
export function computeEfforts(run) {
  const pts = normalizePoints(run.points || []);
  const out = {};
  for (const e of EFFORTS) {
    const t = bestEffort(pts, e.m);
    if (t != null) out[e.m] = Math.round(t);
  }
  // GPS 軌跡のない手入力の記録は、全体を 1 つの記録として扱う
  if (!pts.length && run.distance) {
    for (const e of EFFORTS) {
      if (Math.abs(run.distance - e.m) <= e.m * 0.01) out[e.m] = Math.round(run.duration / 1000);
    }
  }
  return out;
}

// 距離ごとの自己ベスト { [m]: {sec, runId, date} }
export function personalRecords(runs) {
  const prs = {};
  for (const r of runs) {
    const ef = r.efforts || {};
    for (const [m, sec] of Object.entries(ef)) {
      if (!prs[m] || sec < prs[m].sec) prs[m] = { sec, runId: r.id, date: r.startedAt };
    }
  }
  return prs;
}

// 今回のランで更新した自己ベスト（今回より前の記録と比べる）
export function newRecordsIn(run, runs) {
  const before = personalRecords(runs.filter((r) => r.id !== run.id && r.startedAt < run.startedAt));
  const out = [];
  for (const e of EFFORTS) {
    const sec = run.efforts?.[e.m];
    if (sec != null && (!before[e.m] || sec < before[e.m].sec)) out.push({ ...e, sec, prev: before[e.m]?.sec ?? null });
  }
  return out;
}

// リーゲルの式によるレース予想。直近 90 日の記録のうち、いちばん長い距離のベストを基準にする
export function predictRaces(runs, now) {
  const recent = runs.filter((r) => r.startedAt >= now - 90 * DAY);
  const prs = personalRecords(recent);
  const base = EFFORTS.filter((e) => prs[e.m]).pop();
  if (!base) return null;
  const { sec } = prs[base.m];
  return {
    base: { ...base, sec },
    races: EFFORTS.filter((e) => e.m >= 5000).map((e) => ({ ...e, sec: sec * Math.pow(e.m / base.m, 1.06) })),
  };
}

// 何週連続で走っているか（今週まだ走っていなくても先週まで続いていれば数える）
export function weekStreak(runs, now) {
  const weeks = new Set(runs.map((r) => weekStart(r.startedAt)));
  let start = weekStart(now);
  if (!weeks.has(start)) start = weekStart(start - DAY);
  let n = 0;
  while (weeks.has(start)) { n++; start = weekStart(start - DAY); }
  return n;
}

// カレンダー用: その月の日ごとの距離
export function dailyDistance(runs, year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  const out = Array(days).fill(0);
  for (const r of runs) {
    const d = new Date(r.startedAt);
    if (d.getFullYear() === year && d.getMonth() === month) out[d.getDate() - 1] += r.distance;
  }
  return out;
}

// シューズごとの累計距離
export function shoeMileage(runs) {
  const out = {};
  for (const r of runs) if (r.shoeId) out[r.shoeId] = (out[r.shoeId] || 0) + r.distance;
  return out;
}
