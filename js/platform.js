// 実行環境ごとの差（ブラウザ / ネイティブアプリ）を吸収する
// ネイティブ版（Capacitor）では、画面ロック中も GPS と音声を使えるプラグインを使う。

export function isNative() {
  const C = window.Capacitor;
  if (!C) return false;
  if (typeof C.isNativePlatform === 'function') return C.isNativePlatform();
  return typeof C.getPlatform === 'function' && C.getPlatform() !== 'web';
}

// ネイティブ版のビルドでは vendor/capacitor/core.js（@capacitor/core）が同梱される。
// プラグインはどんなメソッド名にも応えるプロキシで、then まで持っているため、
// そのまま Promise で返すと「待ち続ける」。必ず { plugin } に包んで受け渡す。
const plugins = new Map();
function nativePlugin(name) {
  if (!isNative()) return Promise.resolve(null);
  if (!plugins.has(name)) {
    plugins.set(name, (async () => {
      const C = window.Capacitor;
      if (typeof C.registerPlugin === 'function') return { plugin: C.registerPlugin(name) };
      const core = await import('../vendor/capacitor/core.js');
      return { plugin: core.registerPlugin(name) };
    })().catch(() => null));
  }
  return plugins.get(name);
}

// プラグインを受け取って fn を呼ぶ（プラグインを Promise の値にしないための入口）
function withPlugin(name, fn) {
  return nativePlugin(name).then((box) => fn(box?.plugin ?? null));
}

/**
 * 位置の監視を始める。onFix({lat, lon, acc, alt, altAcc, speed, t}), onError({code, message})
 * 戻り値は監視を止める関数。
 */
export function watchLocation(onFix, onError) {
  if (isNative()) {
    let id = null, stopped = false, bg = null;
    withPlugin('BackgroundGeolocation', (p) => {
      bg = p;
      if (!bg) { onError({ code: 2, message: '位置情報のプラグインが見つかりません' }); return; }
      if (stopped) return;
      return bg.addWatcher({
        backgroundTitle: 'RunLog 計測中',
        backgroundMessage: 'ランを記録しています',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      }, (loc, err) => {
        if (err) { onError({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2, message: err.message }); return; }
        onFix({
          lat: loc.latitude, lon: loc.longitude, acc: loc.accuracy,
          alt: loc.altitude ?? null, altAcc: loc.altitudeAccuracy ?? null,
          speed: loc.speed != null && loc.speed >= 0 ? loc.speed : null,
          t: Date.now(),
        });
      }).then((wid) => { id = wid; if (stopped) bg.removeWatcher({ id }); });
    });
    return () => { stopped = true; if (id != null) bg?.removeWatcher({ id }); };
  }

  if (!('geolocation' in navigator)) { onError({ code: 2, message: 'この端末では位置情報が使えません' }); return () => {}; }
  const wid = navigator.geolocation.watchPosition((pos) => {
    const c = pos.coords;
    onFix({
      lat: c.latitude, lon: c.longitude, acc: c.accuracy,
      alt: c.altitude, altAcc: c.altitudeAccuracy,
      speed: c.speed != null && c.speed >= 0 ? c.speed : null,
      t: Date.now(),
    });
  }, (err) => onError({ code: err.code, message: err.message }), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  return () => navigator.geolocation.clearWatch(wid);
}

// 読み上げ。ネイティブ版は画面ロック中でも話せるプラグインを優先する
export function speakText(text) {
  if (isNative()) {
    withPlugin('TextToSpeech', (tts) => { tts?.speak({ text, lang: 'ja-JP', rate: 1.0, category: 'playback' }).catch(() => {}); });
    return;
  }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// ネイティブ版では位置情報の権限を OS が管理するので、ブラウザの権限 API は使わない
export async function locationPermission() {
  if (isNative()) return 'native';
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'unknown'; }
}
