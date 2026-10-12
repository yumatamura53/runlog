// sw.js の SHELL に載っているファイルがすべて存在し、js/ の全ファイルが SHELL に入っているか
import fs from 'fs';
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const list = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
const missing = list.filter((f) => f !== './' && !fs.existsSync(new URL('../' + f, import.meta.url)));
const js = fs.readdirSync(new URL('../js', import.meta.url)).map((f) => 'js/' + f).filter((f) => !list.includes(f));
console.log(missing.length || js.length ? `NG 存在しない: ${missing} / 未登録: ${js}` : 'OK sw.js のファイル一覧');
process.exit(missing.length || js.length ? 1 : 0);
