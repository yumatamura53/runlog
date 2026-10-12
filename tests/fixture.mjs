// 合成データから GPX を作る（画面確認用）。使い方: node tests/fixture.mjs > sample.gpx
import { Recorder } from '../js/geo.js';
import { toGpx, upgrade } from '../js/store.js';
import { simulate, cityLoop } from './sim.mjs';
const seed = Number(process.argv[2] || 5), days = Number(process.argv[3] || 0);
const t0 = Date.UTC(2026, 9, 11, 21, 30) - days * 86400000;
const legs = cityLoop(2.9 + (seed % 5) * 0.12);
const { fixes } = simulate(legs, { noise: 5, corr: 0.95, seed, alt: (d) => 15 + 12 * Math.sin(d / 600) });
const r = new Recorder(); r.start(t0);
for (const f of fixes) r.addFix({ ...f, t: f.t + t0 });
process.stdout.write(toGpx(upgrade({ ...r.finish(t0 + fixes[fixes.length - 1].t), title: `テストラン ${seed}` })));
