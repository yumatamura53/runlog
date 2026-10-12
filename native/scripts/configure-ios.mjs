// iOS の Info.plist に、位置情報・バックグラウンド動作に必要な設定を追加する（何度実行しても同じ結果）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plist = path.join(root, 'ios/App/App/Info.plist');
if (!fs.existsSync(plist)) { console.error('先に npx cap add ios を実行してください'); process.exit(1); }
let xml = fs.readFileSync(plist, 'utf8');

const entries = {
  NSLocationWhenInUseUsageDescription: '<string>ランの距離とルートを記録するために位置情報を使います</string>',
  NSLocationAlwaysAndWhenInUseUsageDescription: '<string>画面をロックしている間もランを記録し続けるために位置情報を使います</string>',
  // location: 画面ロック中も GPS を受け取る / audio: 画面ロック中も音声ガイドを読み上げる
  UIBackgroundModes: '<array>\n\t\t<string>location</string>\n\t\t<string>audio</string>\n\t</array>',
};
for (const [key, value] of Object.entries(entries)) {
  if (xml.includes(`<key>${key}</key>`)) continue;
  xml = xml.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t${value}\n</dict>\n</plist>\n`);
}
fs.writeFileSync(plist, xml);
console.log('Info.plist を設定しました');
