// 表示用の書式

const pad = (n) => String(n).padStart(2, '0');

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 30 * 60) return `--'--"`;
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}'${pad(s % 60)}"`;
}

export const fmtKm = (m, digits = 2) => (Math.max(0, m) / 1000).toFixed(digits);

export function fmtDate(ts, withTime = true) {
  const d = new Date(ts);
  const w = '日月火水木金土'[d.getDay()];
  const date = `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
  return withTime ? `${date} ${d.getHours()}:${pad(d.getMinutes())}` : date;
}

export function fmtDateISO(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 音声読み上げ用（「5分12秒」など）
export function sayDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? h + '時間' : ''}${m ? m + '分' : ''}${sec || (!h && !m) ? sec + '秒' : ''}`;
}

export function sayPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '';
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}分${s % 60 ? (s % 60) + '秒' : ''}`;
}

export function sayKm(m) {
  const km = m / 1000;
  return Number.isInteger(Math.round(km * 100) / 100) ? `${Math.round(km)}キロ` : `${km.toFixed(km < 10 ? 2 : 1).replace(/0$/, '')}キロ`;
}

// "5:30" や "530" → 330 秒
export function parsePace(text) {
  const t = String(text).trim();
  let m = t.match(/^(\d{1,2})\s*[:'分]\s*(\d{1,2})/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d{1,2})(\d{2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d{1,2})$/);
  if (m) return +m[1] * 60;
  return NaN;
}

// "1:30:00" "45:00" "45" → ms
export function parseDuration(text) {
  const parts = String(text).trim().split(/[:：]/).map(Number);
  if (!parts.length || parts.some((n) => !isFinite(n) || n < 0)) return NaN;
  if (parts.length === 1) return parts[0] * 60000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}
