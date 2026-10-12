import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, bestEffort, paceSeries, trimEnds, normalizePoints, splitElevation, haversine } from '../js/geo.js';
import { simulate, cityLoop } from './sim.mjs';

function record(fixes, opts) {
  const r = new Recorder(opts); r.start(fixes[0].t);
  const events = [];
  for (const f of fixes) events.push(...r.addFix(f));
  return { r, events };
}

test('5km を ±2% 以内で計測し、5 回 km 通過を知らせる', () => {
  const { fixes, trueDist, trueTime } = simulate(cityLoop(3.2), { noise: 6, corr: 0.95, seed: 3 });
  const { r, events } = record(fixes);
  assert.ok(Math.abs(r.distance - trueDist) / trueDist < 0.02, `distance ${r.distance}`);
  const splits = events.filter((e) => e.type === 'split');
  assert.equal(splits.length, Math.floor(r.distance / 1000));
  for (const s of splits) assert.ok(Math.abs(s.lapMs / 1000 - 312.5) < 20, `lap ${s.lapMs}`);
  const rec = r.finish(trueTime * 1000);
  assert.ok(Math.abs(rec.duration / 1000 - trueTime) < 1.5);
});

test('GPS の大きな飛びは距離に入らない', () => {
  const { fixes, trueDist } = simulate(cityLoop(3), { noise: 5, corr: 0.95, seed: 5 });
  fixes[200] = { ...fixes[200], lat: fixes[200].lat + 0.01 };       // 1km 先へ飛ぶ
  fixes[400] = { ...fixes[400], acc: 120 };                           // 精度が悪い測位
  const { r } = record(fixes);
  assert.ok(Math.abs(r.distance - trueDist) / trueDist < 0.02);
});

test('手動一時停止中の移動は距離にも時間にも入らない', () => {
  const { fixes } = simulate([{ dist: 600, heading: 0, speed: 3 }, { dist: 300, heading: 0, speed: 3 }, { dist: 600, heading: 0, speed: 3 }], { noise: 3, corr: 0.95, seed: 2 });
  const r = new Recorder(); r.start(0);
  for (const f of fixes) {
    if (f.t === 200000) r.pause(f.t);
    if (f.t === 300000) r.resume(f.t);
    r.addFix(f);
  }
  const rec = r.finish(fixes[fixes.length - 1].t);
  assert.ok(Math.abs(rec.distance - 1200) < 40, `distance ${rec.distance}`);
  assert.ok(Math.abs(rec.duration / 1000 - 400) < 2, `duration ${rec.duration}`);
  assert.equal(new Set(rec.points.map((p) => p[3])).size, 2, '区間が 2 つに分かれる');
});

test('自動一時停止: 信号待ちの時間は計測タイムに入らない', () => {
  const { fixes } = simulate([{ dist: 900, heading: 0, speed: 3 }, { stop: 90 }, { dist: 900, heading: 90, speed: 3 }], { noise: 5, corr: 0.95, seed: 4 });
  const { r, events } = record(fixes, { autopause: true });
  assert.ok(events.some((e) => e.type === 'autopause'));
  assert.ok(events.some((e) => e.type === 'autoresume'));
  const rec = r.finish(fixes[fixes.length - 1].t);
  assert.ok(rec.duration / 1000 < 600 + 15, `duration ${rec.duration / 1000}`); // 走った 600 秒 + 判定待ち
  assert.ok(Math.abs(rec.distance - 1800) < 50, `distance ${rec.distance}`);
});

test('途中保存から復元しても続きを計測できる', () => {
  const { fixes, trueDist } = simulate(cityLoop(3), { noise: 4, corr: 0.95, seed: 9 });
  const r = new Recorder(); r.start(0);
  const half = fixes.length >> 1;
  for (const f of fixes.slice(0, half)) r.addFix(f);
  const r2 = Recorder.restore(JSON.parse(JSON.stringify(r)));
  for (const f of fixes.slice(half)) r2.addFix(f);
  assert.ok(Math.abs(r2.distance - trueDist) / trueDist < 0.02);
});

test('標高: 揺れは数えず、40m の上りはおおむね数える', () => {
  const hill = (d) => (d < 1000 ? 10 : d < 2000 ? 10 + (d - 1000) * 0.04 : 50);
  const { fixes } = simulate([{ dist: 3000, heading: 0, speed: 3 }], { noise: 4, corr: 0.95, seed: 1, alt: hill });
  const rec = record(fixes).r.finish(1e7);
  assert.ok(rec.elevGain >= 30 && rec.elevGain <= 50, `gain ${rec.elevGain}`);
  assert.ok(rec.elevLoss <= 10, `loss ${rec.elevLoss}`);
  const se = splitElevation(rec.points);
  assert.ok(se[1].gain > se[0].gain && se[1].gain > se[2].gain);
});

test('ベストエフォート（最速 1km）を区間内から見つける', () => {
  // 0-2km は 6:00/km、2-3km は 4:00/km
  const pts = [];
  for (let d = 0; d <= 3000; d += 10) {
    const t = d <= 2000 ? d * 0.36 : 720 + (d - 2000) * 0.24;
    pts.push([0, 0, t, 0, null, d]);
  }
  assert.equal(Math.round(bestEffort(pts, 1000)), 240);
  assert.equal(Math.round(bestEffort(pts, 3000)), 960);
  assert.equal(bestEffort(pts, 5000), null);
  const series = paceSeries(pts, 500);
  assert.equal(Math.round(series[0].pace), 360);
  assert.equal(Math.round(series[series.length - 1].pace), 240);
});

test('プライバシー: 前後 200m を取り除く', () => {
  const pts = Array.from({ length: 101 }, (_, i) => [0, 0, i, 0, null, i * 10]);
  const t = trimEnds(pts, 200);
  assert.equal(t[0][5], 200);
  assert.equal(t[t.length - 1][5], 800);
  assert.deepEqual(trimEnds(pts.slice(0, 30), 200), []);
});

test('旧形式の記録に累計距離を補う', () => {
  const a = { lat: 35.68, lon: 139.76 }, b = { lat: 35.681, lon: 139.76 };
  const pts = normalizePoints([[a.lat, a.lon, 0, 0], [b.lat, b.lon, 30, 0], [a.lat, a.lon, 60, 1]]);
  assert.equal(pts[1][5], Math.round(haversine(a, b) * 10) / 10);
  assert.equal(pts[2][5], pts[1][5], '区間をまたぐ移動は足さない');
});
