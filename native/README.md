# RunLog ネイティブ版（画面ロック中も記録できる版）

ブラウザ版の RunLog は、iPhone の仕様で **画面をロックすると GPS が止まります**。
このフォルダは、同じアプリを **iPhone / Android のアプリとしてビルド** するためのものです。
アプリにすると、Strava やラントリップと同じように **画面ロック中・ポケットの中でも GPS と音声ガイドが動きます**。

中身は Web 版と同じコードで、ネイティブ版のときだけ次のプラグインを使います。

| 用途 | プラグイン |
|---|---|
| 画面ロック中の GPS | `@capacitor-community/background-geolocation` |
| 画面ロック中の音声ガイド | `@capacitor-community/text-to-speech` |

> ⚠️ このフォルダは Linux 上でプロジェクト生成と設定まで確認済みですが、**実機でのビルド・動作確認はまだ** です（Mac が必要なため）。
> 偽のプラグインを使ったブラウザ上のテストで、GPS → 距離計算 → 音声読み上げがつながることは確認しています。

---

## iPhone に入れる手順（Mac が必要）

### 必要なもの
- Mac（Xcode 16 以降をインストール）
- Node.js 20 以降
- Apple ID（無料で OK。有料の Apple Developer Program は不要）
- iPhone と USB ケーブル

### 1. 準備（最初の 1 回だけ）
```sh
cd native
npm install
npm run setup      # Web 版をコピー → iOS / Android プロジェクト作成 → 位置情報の設定を追加
npm run ios        # Xcode が開きます
```

### 2. Xcode での設定（最初の 1 回だけ）
1. 左のツリーで **App** → **Signing & Capabilities** を開く
2. **Team** で自分の Apple ID を選ぶ（「Add an Account…」からサインイン）
3. **Bundle Identifier** を自分だけの名前に変える（例: `com.あなたの名前.runlog`）
4. 「+ Capability」→ **Background Modes** を追加し、**Location updates** と **Audio, AirPlay, and Picture in Picture** にチェック
   （`npm run setup` で Info.plist には書き込み済みですが、Xcode 上でもチェックが入っているか確認してください）

### 3. iPhone で動かす
1. iPhone を USB でつなぎ、Xcode 上部で自分の iPhone を選んで ▶（Run）
2. 初回は iPhone 側で
   - 設定 → プライバシーとセキュリティ → **デベロッパモード** をオン（再起動あり）
   - 設定 → 一般 → VPN とデバイス管理 → 自分の Apple ID を **信頼**
3. アプリを開き、位置情報を **「App の使用中は許可」** にする（ロック中の記録もこれで動きます。青い位置情報アイコンが出ます）

### 無料の Apple ID の制限
- インストールしたアプリは **7 日で起動できなくなります**。そのときは Mac につないで Xcode で ▶ を押し直してください（記録は消えません）
- 年額の Apple Developer Program（99 ドル）に入ると 1 年間有効になり、TestFlight でも入れられます

### Web 版を直したあと
```sh
npm run ios   # Web 版をコピーし直して Xcode を開く → ▶
```

---

## Android に入れる手順
1. Android Studio をインストール
2. `npm install` → `npm run setup` → `npm run android`
3. Android Studio で端末を選んで ▶
4. Android 13 以降は、通知の許可も「許可」にしてください（計測中の常駐通知に必要です）

---

## 記録の引っ越し
ブラウザ版とアプリ版の記録は別々に保存されます。
ブラウザ版の **設定 → データ → バックアップを書き出す** で保存したファイルを、アプリ版の **バックアップから復元** で読み込めます。
