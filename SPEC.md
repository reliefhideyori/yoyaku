# 予約フォーム — 仕様書・セットアップガイド

## 概要

LPへの埋め込みを想定した1ページの予約フォーム。
Google Apps Script (GAS) をバックエンドに、Google Calendar API 経由で空き枠管理・予約作成を行う。

---

## ファイル構成

```
予約フォームテスト/
├── index.html       フロントエンド（HTML+CSS+JS 1ファイル完結）
├── SPEC.md          本ファイル
└── gas/
    └── Code.gs      Google Apps Script バックエンド
```

---

## 仕様

| 項目 | 内容 |
|---|---|
| 受付時間 | 毎日 9:00〜21:00 |
| 枠の刻み | 30分単位 |
| 選択可能な利用時間 | 1時間 / 2時間 / 3時間 |
| 最終スロット開始時刻 | 1h→20:00, 2h→19:00, 3h→18:00 |
| 取得情報 | 氏名（必須）、電話番号（必須）、メモ（任意） |
| デザイン | ミニマル・高級感 / アクセントカラー #8B7355 |
| GAS URL未設定時 | デモモードで動作（実際のカレンダー連携なし） |

---

## GAS セットアップ手順

### 1. GAS プロジェクト作成

1. [https://script.google.com](https://script.google.com) を開く
2. 「新しいプロジェクト」をクリック
3. プロジェクト名を「予約フォームGAS」などに変更
4. デフォルトの `myFunction()` を全削除
5. `gas/Code.gs` の内容をすべて貼り付ける

### 2. カレンダーID設定（必要な場合）

- `CODE.gs` 上部の `CONFIG.CALENDAR_ID` を確認
- デフォルトは `'primary'`（Googleアカウントのメインカレンダー）
- 別のカレンダーを使う場合: Googleカレンダー設定 → 「カレンダーの統合」→ カレンダーID をコピーして設定

### 3. ウェブアプリとしてデプロイ

1. 「デプロイ」→「新しいデプロイ」
2. 種類: **ウェブアプリ**
3. 次のように設定:
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
4. 「デプロイ」をクリック
5. 権限の確認ダイアログが出たら許可する（Googleカレンダーへのアクセス）
6. 表示された **ウェブアプリ URL** をコピーする

### 4. フロントエンドにURLを設定

`index.html` の先頭付近にある以下の行を編集:

```javascript
const GAS_URL = 'YOUR_GAS_WEBAPP_URL';  // ← ここに貼り付け
```

例:
```javascript
const GAS_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

### 5. 動作確認

1. `index.html` をブラウザで開く（ローカルファイル `file://` でも動作可）
2. 全4ステップを通して予約を完了
3. Googleカレンダーでイベントが作成されているか確認

### 6. コード変更後の再デプロイ

`Code.gs` を変更した場合:
デプロイ → デプロイを管理 → 鉛筆アイコン → バージョン「新しいバージョン」→ デプロイ
（URLは変わらない）

---

## LP への埋め込み方法

### Option A — iframe（推奨・シンプル）

```html
<iframe
  src="./予約フォームテスト/index.html"
  width="100%"
  height="850px"
  frameborder="0"
  style="border:none;"
></iframe>
```

### Option B — インライン統合（シームレスなデザイン統合）

1. `index.html` の `<style>` 内容を LP の `<style>` に追加
2. ただし CSS の競合を避けるため、全セレクタを `.reservation-form { ... }` でラップする
3. `<body>` 内の `.booking-wrap` div を LP の埋め込み箇所に貼り付け
4. `<script>` 内容を LP の `<script>` に追加

---

## GAS API 仕様

### GET — 空き枠取得

```
GET {GAS_URL}?date=YYYY-MM-DD&duration=N
```

**レスポンス:**
```json
{
  "slots": [
    {"time": "09:00", "available": true},
    {"time": "09:30", "available": false},
    ...
  ]
}
```

### POST — 予約作成

```
POST {GAS_URL}
Content-Type: text/plain;charset=utf-8

{"date":"YYYY-MM-DD","time":"HH:MM","duration":N,"name":"山田太郎","phone":"090-1234-5678","memo":"メモ"}
```

**レスポンス（成功）:**
```json
{"success": true, "eventId": "..."}
```

**レスポンス（失敗）:**
```json
{"success": false, "error": "slot_taken"}
{"success": false, "error": "missing_fields"}
```

---

## デモモードについて

`GAS_URL = 'YOUR_GAS_WEBAPP_URL'` のままの場合、実際のAPI通信は行わず
ダミーデータでUIの動作確認ができます。

- デモ用のbusyスロット: 10:00, 11:00, 13:30, 15:00 付近
- 送信ボタンを押すと完了画面に遷移する（カレンダー登録は行われない）

---

## UX フロー

```
STEP 1 → STEP 2 → STEP 3 → STEP 4 → 完了
 時間選択   日付選択   時刻選択   情報入力   サンクス
```

- STEP 1 で選択すると 300ms 後に自動遷移
- STEP 2 で日付を選択すると自動遷移 + スロット取得開始
- STEP 3 で時刻を選択すると 200ms 後に自動遷移
- 各ステップに「戻る」ボタンあり
- スロット取得中はスケルトン表示（3秒後に案内テキスト追加）

---

## 今後の拡張ポイント

- [ ] 確認メール送信（GAS + Gmail API）
- [ ] キャンセル機能
- [ ] 管理者向けダッシュボード
- [ ] 予約可能日の事前ハイライト（月単位の一括取得）
- [ ] LP カラーに合わせたアクセントカラー変更（CSS変数 `--accent` を編集）
