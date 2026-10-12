import test from 'node:test';
import assert from 'node:assert/strict';
import { Workout, buildSteps, describePlan, PRESETS } from '../js/workout.js';
import { weeklySeries, personalRecords, predictRaces, weekStreak, newRecordsIn, computeEfforts, sumBetween, weekStart } from '../js/stats.js';
import { fmtPace, fmtDuration, parsePace, parseDuration, sayDuration, sayKm } from '../js/format.js';

const texts = (evs) => evs.filter((e) => e.type === 'say').map((e) => e.text);

test('書式', () => {
  assert.equal(fmtPace(330), `5'30"`);
  assert.equal(fmtPace(NaN), `--'--"`);
  assert.equal(fmtDuration(3723000), '1:02:03');
  assert.equal(fmtDuration(65000), '1:05');
  assert.equal(parsePace('5:30'), 330);
  assert.equal(parsePace('530'), 330);
  assert.equal(parsePace("4'45"), 285);
  assert.equal(parseDuration('1:30:00'), 5400000);
  assert.equal(parseDuration('45'), 2700000);
  assert.equal(sayDuration(312000), '5分12秒');
  assert.equal(sayDuration(300000), '5分');
  assert.equal(sayKm(5000), '5キロ');
  assert.equal(sayKm(2500), '2.5キロ');
});

test('インターバル: 手順どおり進み、案内が出る', () => {
  const plan = { type: 'interval', warmupMs: 60000, reps: 3, work: { m: 400 }, restMs: 60000, cooldownMs: 60000 };
  assert.equal(buildSteps(plan).length, 1 + 3 + 2 + 1);
  assert.match(describePlan(plan), /400m×3/);
  const w = new Workout(plan);
  assert.match(texts(w.intro())[0], /400メートルを3本/);
  const said = [];
  let el = 0, dist = 0;
  // 3.3m/s で走り、レスト中も歩く（1m/s）
  while (!w.done && el < 3600000) {
    el += 1000;
    const kind = w.step?.kind;
    dist += kind === 'rest' ? 1 : 3.3;
    said.push(...texts(w.update(el, dist, 300)));
  }
  assert.equal(w.done, true);
  assert.ok(Math.abs(w.results[1].ms - 400 / 3.3 * 1000) < 50, String(w.results[1].ms));
  assert.deepEqual(w.results.map((r) => r.kind), ['warmup', 'work', 'rest', 'work', 'rest', 'work', 'cooldown']);
  assert.ok(said.includes('1本目 スタート。400メートル'), said.join(' / '));
  assert.ok(said.some((t) => /^1本目 終了。タイム 2分1秒$/.test(t)), said.join(' / '));
  assert.ok(said.includes('あと10秒でラン'));
  assert.ok(said.includes('ワークアウト完了です。お疲れさまでした'));
  const v = new Workout(plan);
  assert.equal(v.view(0, 0).title, 'ウォームアップ');
});

test('目標距離: 半分・残り1km・残り500m・到達を知らせる', () => {
  const w = new Workout({ type: 'distance', meters: 5000 });
  const said = [];
  for (let el = 1000, d = 3; d <= 5100; el += 1000, d += 3) said.push(...texts(w.update(el, d, 333)));
  assert.deepEqual(said.slice(0, 3), ['半分です。残り2.5キロ', '残り1キロ', '残り500メートル']);
  assert.match(said[3], /^目標の5キロに到達しました。タイム 27分/);
  assert.equal(w.done, true);
});

test('ペース目標: 遅れ・速すぎを 60 秒おきに知らせる', () => {
  const w = new Workout({ type: 'free', pace: 330 });
  const said = [];
  for (let el = 0; el <= 180000; el += 1000) said.push(...texts(w.update(el, el / 300, el < 100000 ? 360 : 300)));
  assert.ok(said[0].startsWith('ペースが遅れています'));
  assert.ok(said.some((t) => t.startsWith('ペースが速すぎます')));
  assert.ok(said.length <= 3);
});

test('途中保存から復元できる', () => {
  const w = new Workout(PRESETS.find((p) => p.id === 'i400').plan);
  w.update(700000, 2000, 300);
  const w2 = Workout.restore(JSON.parse(JSON.stringify(w)));
  assert.equal(w2.i, w.i);
  assert.ok(w2.announced instanceof Set);
});

const day = (y, m, d, h = 7) => new Date(y, m - 1, d, h).getTime();
const run = (ts, km, min, efforts = {}) => ({ id: ts, startedAt: ts, distance: km * 1000, duration: min * 60000, efforts });

test('集計: 週ごと・自己ベスト・連続週・予想タイム', () => {
  const now = day(2026, 10, 14); // 水曜
  const runs = [
    run(day(2026, 10, 12), 5, 30, { 1000: 330, 5000: 1800 }),
    run(day(2026, 10, 13), 10, 62, { 1000: 340, 5000: 1790, 10000: 3720 }),
    run(day(2026, 10, 8), 8, 50),
    run(day(2026, 9, 28), 3, 20),
    run(day(2026, 9, 10), 3, 20),
  ];
  assert.equal(new Date(weekStart(now)).getDay(), 1);
  const weeks = weeklySeries(runs, now, 4);
  assert.deepEqual(weeks.map((w) => w.dist / 1000), [0, 3, 8, 15]);
  assert.equal(sumBetween(runs, weekStart(now)).count, 2);
  const prs = personalRecords(runs);
  assert.equal(prs[1000].sec, 330);
  assert.equal(prs[5000].sec, 1790);
  assert.equal(weekStreak(runs, now), 3);
  const pred = predictRaces(runs, now);
  assert.equal(pred.base.m, 10000);
  const half = pred.races.find((r) => r.m === 21097.5);
  assert.ok(half.sec > 7800 && half.sec < 8400, String(half.sec));
  const nr = newRecordsIn(runs[1], runs);
  assert.deepEqual(nr.map((r) => r.label), ['5km', '10km']);
});

test('手入力の記録（軌跡なし）は距離ぴったりならベストに数える', () => {
  assert.deepEqual(computeEfforts({ points: [], distance: 5000, duration: 1500000 }), { 5000: 1500 });
  assert.deepEqual(computeEfforts({ points: [], distance: 4300, duration: 1500000 }), {});
});
