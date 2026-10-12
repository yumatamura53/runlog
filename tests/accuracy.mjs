// 距離精度の比較: 旧方式（v1）と新方式（カルマン＋ドップラー速度）
import { Recorder, haversine } from '../js/geo.js';
import { simulate, cityLoop } from './sim.mjs';

function v1(fixes) { // 最初の版のアルゴリズムを再現
  let anchor = null, dist = 0, streak = 0;
  for (const f of fixes) {
    if (f.acc > 35) continue;
    if (!anchor) { anchor = f; continue; }
    const d = haversine(anchor, f), dt = Math.max(0.001, (f.t - anchor.t) / 1000);
    if (d / dt > 10) { if (++streak >= 5) { streak = 0; anchor = f; } continue; }
    streak = 0;
    if (d < Math.max(3, Math.min(f.acc, 20) * 0.5)) continue;
    dist += d; anchor = f;
  }
  return dist;
}
function v2(fixes, opts) {
  const r = new Recorder(opts); r.start(fixes[0].t);
  for (const f of fixes) r.addFix(f);
  return r;
}
const C = Number(process.env.CORR || 0.95);
const scenarios = [
  ['街中5km 誤差4m', cityLoop(), { noise: 4, corr: C }],
  ['街中5km 誤差8m（ビル街）', cityLoop(), { noise: 8, corr: C }],
  ['街中5km 誤差8m＋飛び2%', cityLoop(), { noise: 8, spikes: 0.02, corr: C }],
  ['ゆっくりジョグ 6:30/km 誤差6m', cityLoop(2.56), { noise: 6, corr: C }],
  ['信号待ち3回(各60秒)', [{ dist: 1000, heading: 0, speed: 3 }, { stop: 60 }, { dist: 1000, heading: 90, speed: 3 }, { stop: 60 }, { dist: 1000, heading: 180, speed: 3 }, { stop: 60 }], { noise: 6, corr: C }],
  ['GPS速度なし（古い端末）', cityLoop(), { noise: 6, corr: C, nospeed: true }],
  ['速めのペース走 4:00/km', cityLoop(4.17), { noise: 5, corr: C }],
];
console.log('シナリオ | 正解 | 旧方式 平均誤差 | 新方式 平均誤差 | 新方式 |誤差|平均 | 新方式 最大|誤差|');
for (const [name, legs, opt] of scenarios) {
  let e1 = 0, e2 = 0, a2 = 0, m2 = 0, n = 10, truth;
  for (let s = 1; s <= n; s++) {
    const { fixes, trueDist } = simulate(legs, { ...opt, seed: s * 7 });
    truth = trueDist;
    e1 += (v1(fixes) - trueDist) / trueDist;
    const err = (v2(fixes).distance - trueDist) / trueDist;
    e2 += err; a2 += Math.abs(err); m2 = Math.max(m2, Math.abs(err));
  }
  console.log(`${name} | ${(truth / 1000).toFixed(2)}km | ${(e1 / n * 100).toFixed(1)}% | ${(e2 / n * 100).toFixed(1)}% | ${(a2 / n * 100).toFixed(1)}% | ${(m2 * 100).toFixed(1)}%`);
}
// 静止 5 分（家の前で GPS を待つ等）
let s1 = 0, s2 = 0;
for (let s = 1; s <= 10; s++) {
  const { fixes } = simulate([{ stop: 300 }], { noise: 8, seed: s, corr: C });
  s1 += v1(fixes); s2 += v2(fixes).distance;
}
console.log(`静止5分 誤差8m | 0m | ${(s1 / 10).toFixed(0)}m | ${(s2 / 10).toFixed(0)}m`);
