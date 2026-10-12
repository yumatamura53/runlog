// アプリ本体をキャッシュして、電波がなくてもすぐ起動できるようにする
const CACHE = 'runlog-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/platform.js', 'js/geo.js', 'js/workout.js', 'js/stats.js', 'js/format.js', 'js/store.js', 'js/charts.js', 'js/map.js', 'js/share.js',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png', 'vendor/leaflet/images/layers.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('runlog-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // 地図タイルなどはそのまま
  // キャッシュがあれば即返し、裏で新しい版を取りに行く（次回起動時に反映）
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
