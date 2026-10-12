// アプリ本体をキャッシュして、電波がなくてもすぐ起動できるようにする。
// 更新するときは CACHE の番号を上げる。新しい版はまとめて取得し、全部そろってから切り替わる
// （古いファイルと新しいファイルが混ざって起動できなくなるのを防ぐ）。
const CACHE = 'runlog-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/platform.js', 'js/geo.js', 'js/workout.js', 'js/stats.js', 'js/format.js', 'js/store.js',
  'js/charts.js', 'js/map.js', 'js/share.js',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png', 'vendor/leaflet/images/layers.png',
];

self.addEventListener('install', (e) => {
  // HTTP キャッシュを通さず、必ずサーバーから最新を取る
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('runlog-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // 地図タイルなどはそのまま
  // 同じ版のキャッシュだけから返す。無ければネットワーク
  e.respondWith(caches.open(CACHE)
    .then((c) => c.match(e.request, { ignoreSearch: true }))
    .then((hit) => hit || fetch(e.request)));
});
