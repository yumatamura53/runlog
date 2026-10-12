import test from 'node:test';
import assert from 'node:assert/strict';
import { toGpx, parseGpx, upgrade, makeBackup, readBackup, autoTitle } from '../js/store.js';
import { Recorder } from '../js/geo.js';
import { simulate, cityLoop } from './sim.mjs';

function sampleRun() {
  const hill = (d) => 20 + 15 * Math.sin(d / 400);
  const { fixes } = simulate(cityLoop(3.1), { noise: 4, corr: 0.95, seed: 11, alt: hill });
  const t0 = Date.UTC(2026, 9, 10, 22, 0, 0);
  const r = new Recorder(); r.start(t0);
  for (const f of fixes) r.addFix({ ...f, t: f.t + t0 });
  const rec = upgrade({ ...r.finish(t0 + fixes[fixes.length - 1].t), memo: '朝ラン <テスト> & "引用"' });
  return rec;
}

test('GPX: 書き出し→取り込みで距離・時間・ラップがほぼ一致する', () => {
  const rec = sampleRun();
  const gpx = toGpx(rec);
  assert.match(gpx, /<desc>朝ラン &lt;テスト&gt; &amp; &quot;引用&quot;<\/desc>/);
  const back = parseGpx(gpx);
  assert.ok(Math.abs(back.distance - rec.distance) / rec.distance < 0.02, `${back.distance} vs ${rec.distance}`);
  assert.ok(Math.abs(back.duration - rec.duration) / rec.duration < 0.03, `${back.duration} vs ${rec.duration}`);
  assert.ok(Math.abs(back.splits.length - rec.splits.length) <= 1);
  assert.ok(Math.abs(back.splits[0] - rec.splits[0]) < 5000, `${back.splits[0]} vs ${rec.splits[0]}`);
  assert.ok(back.elevGain > 0);
  assert.ok(back.efforts[1000] > 0);
});

test('GPX: 前後を隠して書き出せる', () => {
  const rec = sampleRun();
  const hidden = parseGpx(toGpx(rec, { hideMeters: 500 }));
  assert.ok(Math.abs(hidden.distance - (rec.distance - 1000)) < 60, String(hidden.distance));
});

test('GPX: lon が先・自己終了タグ・CDATA の名前にも対応', () => {
  const gpx = `<gpx><trk><name><![CDATA[Morning Run]]></name><trkseg>
    <trkpt lon="139.7" lat="35.68"><ele>10</ele><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lon="139.7" lat="35.681"><ele>11</ele><time>2026-01-01T00:00:30Z</time></trkpt>
    <trkpt lon="139.7" lat="35.682"><time>2026-01-01T00:01:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const r = parseGpx(gpx);
  assert.equal(r.title, 'Morning Run');
  assert.ok(Math.abs(r.distance - 222) < 2);
  assert.equal(r.duration, 60000);
  assert.throws(() => parseGpx('<gpx></gpx>'), /軌跡/);
});

test('バックアップの書き出しと読み込み', () => {
  const rec = sampleRun();
  const text = makeBackup([rec], { voice: true });
  const back = readBackup(text);
  assert.equal(back.runs[0].distance, rec.distance);
  assert.deepEqual(back.settings, { voice: true });
  assert.throws(() => readBackup('{"foo":1}'), /バックアップ/);
});

test('自動タイトル', () => {
  assert.equal(autoTitle(new Date(2026, 9, 12, 6, 30).getTime()), '月曜朝のラン');
  assert.equal(autoTitle(new Date(2026, 9, 11, 19, 0).getTime()), '日曜夜のラン');
});
