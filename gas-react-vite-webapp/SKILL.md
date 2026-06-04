---
name: gas-react-vite-webapp
description: TypeScript + Vite + React でローカル開発し、vite-plugin-singlefile で単一 HTML にバンドルして Google Apps Script (GAS) の Web アプリ (doGet) としてデプロイするスタックを構築する。clasp によるプロジェクト連携、appsscript/ サブディレクトリ構成、固定 URL を保つデプロイ運用までを扱う。「GAS Web アプリ」「GAS × React」「clasp デプロイ」「Apps Script フロントエンド」「vite singlefile GAS」「doGet React」「GAS にデプロイ」などのキーワードで使用すること。バックエンドが GAS（スプレッドシート連携など）でフロントを React で作りたい場合の初期構築に使う。
---

# GAS × React × Vite × TypeScript Web アプリ スタック

ローカルで **Vite + React + TypeScript** として開発し、`vite-plugin-singlefile` で
JS/CSS を全部インライン化した **1 枚の HTML** にビルドして、**GAS の `doGet`** がそれを返す、
という構成を作る。GAS をバックエンド（スプレッドシート等）に使う Web アプリに適する。

## 全体像

```
プロジェクトルート/            ← Vite + React プロジェクト
├ index.html                  ← Vite のエントリ（lang="ja" / viewport 設定）
├ vite.config.ts              ← singlefile + 出力先 appsscript/client
├ tsconfig.json / tsconfig.app.json / tsconfig.node.json
├ package.json
├ src/
│  ├ main.tsx
│  └ App.tsx
└ appsscript/                 ← clasp（GAS）プロジェクト。ここが clasp の rootDir
   ├ .clasp.json             ← scriptId / parentId / rootDir:"./"
   ├ appsscript.json         ← timeZone, webapp(executeAs/access) を含むマニフェスト
   ├ server/code.js          ← doGet（ビルド済み HTML を返す）
   └ client/index.html       ← npm run build の出力（push 対象）
```

**鍵となる仕組み**: `npm run build` で React を 1 枚 HTML 化 → `appsscript/client/index.html` に出力 →
`clasp push` で GAS へ送信 → GAS 上では `client/index` という名前のファイルになり、
`doGet` が `createHtmlOutputFromFile('client/index')` で返す。

---

## 前提

- Node.js（v20+ 推奨）と npm。
- clasp v3 系がインストール済み（`npm i -g @google/clasp`）で `clasp login` 済み
  （`~/.clasprc.json` が存在すればログイン済み）。未ログインなら案内: `clasp login`。
- 連携先の GAS プロジェクト（scriptId）。
  - 既存があれば `appsscript/.clasp.json` にその scriptId を書く（クローンなら `clasp clone <scriptId>`）。
  - 新規なら `appsscript/` 内で `clasp create`（スプレッドシート等にバインドする場合は
    `clasp create --type sheets --title "App"` 等。バインド先 ID が `parentId` に入る）。

> **Web 実装のガイド**: UI を実装・修正する際は、グローバル CLAUDE.md の指示に従い
> 作業前に `modern-web-guidance` スキルを起動し、HTML/アクセシビリティ等の一次情報を取得すること。

---

## Step 1: ディレクトリと clasp プロジェクトの配置

`appsscript/` 配下を clasp プロジェクトにする（ルートは Vite 専用に分離する）。

```bash
mkdir -p appsscript/server appsscript/client src
```

### `appsscript/.clasp.json`

```json
{
  "scriptId": "<YOUR_SCRIPT_ID>",
  "rootDir": "./",
  "parentId": "<バインド先のスプレッドシート等のID。standalone なら省略可>",
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"],
  "filePushOrder": [],
  "skipSubdirectories": false
}
```

> `rootDir: "./"` は `.clasp.json` から見た相対。`appsscript/` 配下のファイルだけが push される。

### `appsscript/appsscript.json`（マニフェスト）

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "MYSELF"
  }
}
```

> `webapp` ブロックが Web アプリデプロイに必須。
> - `executeAs`: `USER_DEPLOYING`（デプロイ者として実行）/ `USER_ACCESSING`（アクセス者として実行）
> - `access`: `MYSELF`（自分のみ）/ `ANYONE`（Google ログイン者全員）/ `ANYONE_ANONYMOUS`（誰でも・ログイン不要）
> - 他人に公開するなら `access` を `ANYONE` か `ANYONE_ANONYMOUS` にする。

### `appsscript/server/code.js`

```javascript
/**
 * Web アプリのエントリポイント。
 * Vite がビルドした単一 HTML (client/index.html) を返す。
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('client/index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('My App');
}
```

> GAS にフォルダ概念はないが、clasp はサブディレクトリを `client/index` のような
> スラッシュ入りファイル名にマップする。よって `createHtmlOutputFromFile` の引数は
> 拡張子なしの `'client/index'`。

---

## Step 2: Vite + React + TypeScript プロジェクト（ルート）

### `package.json`

```json
{
  "name": "my-gas-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "push": "npm run build && cd appsscript && clasp push -f",
    "deploy": "npm run build && cd appsscript && clasp push -f && clasp deploy"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/google-apps-script": "^1.0.97",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "vite-plugin-singlefile": "^2.1.0"
  }
}
```

### `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// JS/CSS を 1 枚の HTML にインライン化し、GAS が返せる単一ファイルとして
// appsscript/client/index.html に出力する。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'appsscript/client',
    emptyOutDir: true,
  },
});
```

### `index.html`（ルート）

```html
<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json`

`tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`（`types` に `google-apps-script` を入れて GAS の型を補完）:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["google-apps-script"]
  },
  "include": ["src"]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts"]
}
```

### `src/`

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/App.tsx`（最初は疎通確認用の簡単な画面でよい。セマンティックに `<main>` / 単一 `<h1>`）:

```tsx
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h1>My App</h1>
      <p>GAS × React × TypeScript のデプロイ確認ページ。</p>
    </main>
  );
}
```

---

## Step 3: インストール → ビルド → デプロイ

```bash
npm install
npm run build      # appsscript/client/index.html が生成される（JS/CSS インライン済み）
```

初回デプロイ（新しいデプロイ ID と URL が発行される）:

```bash
cd appsscript
clasp push -f
clasp deploy
```

出力例: `Deployed AKfycb... @1` の `AKfycb...` が **デプロイ ID**。
Web アプリ URL は:

```
https://script.google.com/macros/s/<デプロイID>/exec
```

> `access: MYSELF` の場合、デプロイした Google アカウントでのみアクセス可。
> **初回アクセス時に承認画面**が出るので許可する。
> URL は `clasp deployments` でも確認できる。

---

## Step 4: URL を変えずに再デプロイ（固定 URL 運用）

`clasp deploy`（`-i` なし）は**毎回新しいバージョンと URL** を作る。
**同じ URL を更新し続けたい**場合は、初回に発行されたデプロイ ID を `-i` で指定する。
`package.json` の `deploy` スクリプトをデプロイ ID 付きに書き換えるとよい:

```json
"deploy": "npm run build && cd appsscript && clasp push -f && clasp deploy -i <デプロイID>"
```

以後 `npm run deploy` で、同じ URL の中身だけがバージョンアップ（`@2`, `@3`…）される。

---

## 開発フロー

- `npm run dev` … Vite のホットリロードでローカル開発（GAS には触れない）。
  - ただし `google.script.run`（後述）はローカルでは動かないので、サーバー連携部分は
    ダミーデータでフォールバックするか、push して GAS 上で確認する。
- `npm run push` … ビルド + `clasp push`（スクリプトエディタに反映）。
- `npm run deploy` … ビルド + push + 固定 URL へデプロイ。

---

## 拡張: クライアント ↔ GAS サーバー通信（`google.script.run`）

データ永続化（スプレッドシート等）を行うときは、サーバー側関数を `code.js` に追加し、
クライアントから `google.script.run` で呼ぶ。Promise でラップすると React から扱いやすい。

`appsscript/server/code.js`:

```javascript
function getItems() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
  return sheet.getDataRange().getValues();
}
```

クライアント側ヘルパ（例 `src/gas.ts`）:

```ts
// GAS 実行環境でのみ google.script.run が存在する。
type GasRunner = {
  withSuccessHandler: (cb: (res: unknown) => void) => GasRunner;
  withFailureHandler: (cb: (err: Error) => void) => GasRunner;
  [fn: string]: (...args: unknown[]) => void;
};

export function callGas<T>(fnName: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const runner = (window as unknown as { google?: { script?: { run: GasRunner } } })
      .google?.script?.run;
    if (!runner) {
      reject(new Error('google.script.run は GAS 環境でのみ利用可能です'));
      return;
    }
    runner
      .withSuccessHandler((res) => resolve(res as T))
      .withFailureHandler((err) => reject(err))
      [fnName](...args);
  });
}
```

> ローカル `npm run dev` では `google.script.run` が無いため reject される。
> `import.meta.env.DEV` で分岐してモックデータを返す等のフォールバックを用意すると開発が捗る。

---

## トラブルシューティング

- **画面が真っ白 / index が見つからない**: `doGet` の引数が `'client/index'`（拡張子なし）か、
  `clasp push` 後に GAS 上へ `client/index.html` が存在するか確認（`clasp push` のログにファイル名が出る）。
- **`clasp push` が何も送らない / マニフェストエラー**: `.clasp.json` の `rootDir` と、
  `appsscript.json` が rootDir 直下にあるか確認。
- **URL が毎回変わる**: `clasp deploy` に `-i <デプロイID>` を付ける（Step 4）。
- **403 / アクセスできない**: `appsscript.json` の `webapp.access` を確認。公開するなら
  `ANYONE` か `ANYONE_ANONYMOUS` に変更して再デプロイ。
- **コード変更が反映されない**: デプロイし直したか（push だけだと既存デプロイの中身は更新されるが、
  ブラウザキャッシュの可能性もあるのでスーパーリロード）。

---

## 完了確認

1. `npm run build` が成功し `appsscript/client/index.html` が生成される。
2. `npm run deploy` 後、Web アプリ URL（`.../exec`）でブラウザに画面が表示される。
3. 作成・変更したファイル一覧と Web アプリ URL をユーザーに報告する。
