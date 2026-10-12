// 親フォルダの Web 版を www/ にコピーし、@capacitor/core を同梱する
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const web = path.resolve(root, '..');
const www = path.join(root, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
for (const f of ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']) {
  fs.copyFileSync(path.join(web, f), path.join(www, f));
}
for (const d of ['js', 'vendor']) fs.cpSync(path.join(web, d), path.join(www, d), { recursive: true });

const core = path.join(root, 'node_modules/@capacitor/core/dist/index.js');
if (!fs.existsSync(core)) {
  console.error('先に npm install を実行してください');
  process.exit(1);
}
fs.mkdirSync(path.join(www, 'vendor/capacitor'), { recursive: true });
fs.copyFileSync(core, path.join(www, 'vendor/capacitor/core.js'));
console.log('www/ を作成しました');
