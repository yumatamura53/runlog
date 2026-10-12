// 画面の通し確認（合成 GPS を流して 5km 走らせる）。使い方: node tests/e2e.mjs <スクショ保存先>
import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { simulate, cityLoop } from './sim.mjs';
import fs from 'fs';

const out = process.argv[2] || 'shots';
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8765/';
const errors = [];
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); if (!cond) failures++; };

const fakeGeo = () => {
  window.__said = [];
  const w = new Map(); let n = 0;
  navigator.geolocation.watchPosition = (ok) => { w.set(++n, ok); return n; };
  navigator.geolocation.clearWatch = (id) => w.delete(id);
  window.__watchers = () => w.size;
  window.__pushFix = (f) => {
    const pos = { coords: { latitude: f.lat, longitude: f.lon, accuracy: f.acc, altitude: f.alt, altitudeAccuracy: f.altAcc, speed: f.speed, heading: null }, timestamp: Date.now() };
    for (const ok of w.values()) ok(pos);
  };
  const synth = { speak: (u) => window.__said.push(u.text), cancel() {}, getVoices: () => [] };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['geolocation'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
await ctx.addInitScript(fakeGeo);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/tile|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.clock.install({ time: new Date('2026-10-12T06:30:00+09:00') });
await page.goto(BASE);
await page.clock.runFor(500);

// メニュー: 5km を選ぶ
await page.click('#btn-plan');
await page.click('.preset:has-text("5km")');
check((await page.textContent('#plan-name')).includes('5km'), 'メニューで 5km を選べる');

// 自動一時停止オン
await page.click('.tab[data-view=view-settings]');
await page.check('#opt-autopause');
await page.click('.tab[data-view=view-run]');

const hill = (d) => 12 + 18 * Math.sin(d / 700);
const legs = cityLoop(3.2);
legs.splice(3, 0, { stop: 45 });              // 信号待ち
const sim = simulate(legs, { noise: 5, corr: 0.95, seed: 42, alt: hill });
await page.evaluate((f) => window.__pushFix(f), sim.fixes[0]);
await page.screenshot({ path: out + '/01-idle.png' });

await page.click('#btn-start');
await page.clock.runFor(3200);                   // カウントダウン
check(await page.isHidden('#countdown'), 'カウントダウン後に計測開始');
let lastT = sim.fixes[0].t;
for (let i = 1; i < sim.fixes.length; i++) {
  const f = sim.fixes[i];
  await page.clock.runFor(f.t - lastT); lastT = f.t;
  await page.evaluate((f) => window.__pushFix(f), f);
  if (i === 900) await page.screenshot({ path: out + '/02-running.png' });
  if (i === 950) {
    await page.click('#btn-lock');
    await page.screenshot({ path: out + '/03-locked.png' });
    const b = await page.locator('#btn-unlock').boundingBox();
    await page.mouse.move(b.x + 30, b.y + 20); await page.mouse.down(); await page.clock.runFor(900); await page.mouse.up();
    check(await page.isHidden('#lock-overlay'), '長押しで画面ロック解除');
  }
}
await page.clock.runFor(1500);
const dist = parseFloat(await page.textContent('#m-distance'));
check(Math.abs(dist - sim.trueDist / 1000) < 0.1, `距離 ${dist} km（正解 ${(sim.trueDist / 1000).toFixed(2)}）`);
const said = await page.evaluate(() => window.__said);
console.log('   音声:', said.join(' / ').slice(0, 600));
check(said.some((t) => t.startsWith('1キロ。ラップ')), '1km ごとのラップ読み上げ');
check(said.some((t) => t.includes('半分です')), '目標の半分の案内');
check(said.some((t) => t.includes('目標の5キロに到達')), '目標到達の案内');
check(said.includes('自動一時停止') && said.includes('再開します'), '信号待ちで自動一時停止・再開');
await page.screenshot({ path: out + '/04-after.png' });

// 一時停止→終了
await page.click('#btn-pause');
const fb = await page.locator('#btn-finish').boundingBox();
await page.mouse.move(fb.x + 30, fb.y + 20); await page.mouse.down(); await page.clock.runFor(1200); await page.mouse.up();
await page.clock.runFor(800);
await page.waitForSelector('#view-detail.active');
check(true, '終了すると詳細画面へ');
check((await page.inputValue('#d-title')) === '月曜朝のラン', '自動タイトル');
check(await page.locator('#chart-pace svg path.line').count() === 1, 'ペースのグラフ');
check(await page.locator('#chart-elev svg path.area').count() === 1, '標高のグラフ');
check(await page.locator('#d-splits tr').count() >= 5, 'ラップ表');
check(parseInt(await page.textContent('#d-elev')) > 10, '獲得標高 ' + await page.textContent('#d-elev'));
check((await page.textContent('#d-prs')).includes('5km'), '自己ベストの表示');
// ペースのグラフに触れると地図に印
await page.locator('#chart-pace svg').scrollIntoViewIfNeeded();
const cb = await page.locator('#chart-pace svg').boundingBox();
await page.mouse.move(cb.x + cb.width * 0.5, cb.y + 40);
check(await page.isVisible('#chart-pace .chart-tip'), 'グラフのツールチップ');
await page.click('#btn-pacecolor');
await page.selectOption('#d-type', 'ペース走');
await page.fill('#d-memo', 'テスト用のメモ');
await page.clock.runFor(600);
await page.screenshot({ path: out + '/05-detail.png', fullPage: true });

// GPX 書き出し
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-gpx')]);
const gpx = fs.readFileSync(await dl.path(), 'utf8');
check(/<trkpt/.test(gpx) && gpx.includes('<ele>'), 'GPX 書き出し（標高つき）');

// 一覧
await page.click('.tab[data-view=view-history]');
await page.clock.runFor(300);
check(await page.locator('.run-item').count() === 1, '一覧に 1 件');
check((await page.textContent('.run-item')).includes('PB'), '一覧の PB バッジ');

// 手入力
await page.click('#btn-add');
await page.fill('#add-dist', '10');
await page.fill('#add-time', '55:00');
await page.fill('#add-date', '2026-10-08T07:00');
await page.click('#add-save');
await page.clock.runFor(300);
await page.click('.tab[data-view=view-history]');
await page.clock.runFor(300);
check(await page.locator('.run-item').count() === 2, '手入力で追加');

// GPX 取り込み（書き出したものを日時を変えて）
const gpx2 = gpx.replace(/2026-10-1[12]T/g, '2026-10-05T');
await page.setInputFiles('#file-import', { name: 'old.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx2) });
await page.clock.runFor(500);
await page.click('.tab[data-view=view-history]');
await page.clock.runFor(300);
check(await page.locator('.run-item').count() === 3, 'GPX 取り込み');
await page.screenshot({ path: out + '/06-history.png' });

// 分析
await page.click('.tab[data-view=view-stats]');
await page.clock.runFor(300);
check(await page.locator('#chart-weeks .bar').count() >= 1, '週ごとのグラフ');
check((await page.textContent('#pr-rows')).includes('10km'), '自己ベスト表');
check((await page.textContent('#pred-rows')).includes('ハーフ'), '予想タイム');
await page.screenshot({ path: out + '/07-stats.png', fullPage: true });

// 設定・バックアップ
await page.click('.tab[data-view=view-settings]');
await page.fill('#shoe-name', 'テストシューズ');
await page.click('#shoe-form button');
check(await page.locator('#shoe-list li').count() === 1, 'シューズ登録');
const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
const backup = JSON.parse(fs.readFileSync(await bk.path(), 'utf8'));
check(backup.runs.length === 3, 'バックアップ書き出し');
await page.screenshot({ path: out + '/08-settings.png', fullPage: true });

// 計測中の再読み込みからの復元
await page.click('.tab[data-view=view-run]');
await page.click('#btn-plan'); await page.click('.preset:has-text("フリーラン")');
await page.click('#btn-start'); await page.clock.runFor(3200);
let t = sim.fixes[0].t;
for (let i = 1; i < 200; i++) { await page.clock.runFor(1000); await page.evaluate((f) => window.__pushFix(f), sim.fixes[i]); }
await page.clock.runFor(5500);
const before = await page.textContent('#m-distance');
await page.reload();
await page.clock.runFor(1500);
check((await page.textContent('#m-distance')) === before, `再読み込み後も距離を保持（${before} km）`);
check(await page.isVisible('#btn-pause'), '再読み込み後も計測中');

console.log('エラー:', errors.length ? errors : 'なし');
if (errors.length) failures++;
await browser.close();
console.log(failures ? `${failures} 件の失敗` : 'すべて成功');
process.exit(failures ? 1 : 0);
