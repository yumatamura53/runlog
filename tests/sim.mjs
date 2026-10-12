// 合成 GPS 軌跡を作るテスト用ユーティリティ（実データは使わない）
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

const LAT0 = 35.6812, LON0 = 139.7671; // 東京駅付近（合成データの原点）
const mPerLat = 111320, mPerLon = 111320 * Math.cos(LAT0 * Math.PI / 180);

/**
 * legs: [{dist, heading(度), speed(m/s)} | {stop: 秒}]
 * noise: 位置誤差の標準偏差(m), corr: 1秒あたりの誤差の自己相関, spikes: 飛びの確率
 */
export function simulate(legs, { seed = 1, noise = 4, corr = 0.9, spikes = 0, hz = 1, alt = null, nospeed = false } = {}) {
  const r = rng(seed);
  let x = 0, y = 0, t = 0, ex = 0, ey = 0, trueDist = 0;
  const fixes = [];
  const k = Math.sqrt(1 - corr * corr);
  const speedBias = 1 + (Number(process.env.BIAS ?? 0.01)) * gauss(r); // 端末ごとの速度のくせ（±3%）
  const emit = (v) => {
    ex = corr * ex + k * noise * gauss(r);
    ey = corr * ey + k * noise * gauss(r);
    let sx = ex, sy = ey;
    if (spikes && r() < spikes) { sx += 80 * gauss(r); sy += 80 * gauss(r); }
    const acc = Math.max(3, noise * (1.2 + 0.5 * r()));
    fixes.push({
      lat: LAT0 + (y + sy) / mPerLat, lon: LON0 + (x + sx) / mPerLon, acc,
      speed: nospeed ? null : Math.max(0, v * speedBias + 0.5 * gauss(r)), alt: alt ? alt(trueDist) + 3 * gauss(r) : null, altAcc: alt ? 8 : null,
      t: Math.round(t * 1000),
    });
  };
  emit(0);
  for (const leg of legs) {
    if (leg.stop) { for (let i = 0; i < leg.stop * hz; i++) { t += 1 / hz; emit(0); } continue; }
    const h = leg.heading * Math.PI / 180;
    const steps = Math.round(leg.dist / leg.speed * hz);
    for (let i = 0; i < steps; i++) {
      const d = leg.dist / steps;
      x += d * Math.sin(h); y += d * Math.cos(h); trueDist += d; t += 1 / hz;
      emit(leg.speed);
    }
  }
  return { fixes, trueDist, trueTime: t };
}

// 住宅街を周回するような 5km（直角に曲がる道）
export function cityLoop(speed = 3.2) {
  const legs = [];
  const sides = [180, 120, 250, 90, 300, 160];
  let h = 0, total = 0, i = 0;
  while (total < 5000) {
    const d = Math.min(sides[i % sides.length], 5000 - total);
    legs.push({ dist: d, heading: h, speed });
    total += d; h = (h + (i % 3 === 2 ? -90 : 90)) % 360; i++;
  }
  return legs;
}
