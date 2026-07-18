---
name: nextjs-setup
description: create-next-app 直後の Next.js プロジェクトに対して、Prettier・shadcn・Dockerfile（Node.js 24）・AGENTS.md・GitHub Actions CI の初期設定を行う。"next.js セットアップ"、"nextjs 初期設定"、"shadcn 初期化"、"nextjs dockerfile"、"nextjs 環境構築"、"create-next-app 後" などのキーワードで使用すること。
---

# Next.js 初期セットアップ

create-next-app 直後の Next.js プロジェクトに対して、以下の設定を順番に実行する。
各ステップは独立しているので、すでに完了しているものはスキップしてよい。

**前提**: パッケージマネージャーは npm を使用する。

---

## Step 1: Prettier のインストールと設定

### インストール

```bash
npm install --save-dev prettier prettier-plugin-tailwindcss
```

> `prettier-plugin-tailwindcss` は Tailwind CSS のクラス名を自動でソートする公式プラグイン。
> shadcn が Tailwind を使うため、一緒に入れておくと一貫性が保てる。

### `.prettierrc` の作成

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "bracketSpacing": true,
  "endOfLine": "lf",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

### `.prettierignore` の作成

```
node_modules
.next
out
dist
build
*.env*
package-lock.json
```

### `package.json` に scripts を追加

既存の `scripts` に以下を追記する（`format` と `format:check` がなければ追加）:

```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

---

## Step 2: shadcn の初期化

推奨は非対話（`-d`）実行。現行の shadcn（4.x）は Tailwind v4 / Next.js を自動検出し、
`components.json`・`lib/utils.ts`・`components/ui/button.tsx` の生成と `app/globals.css` の
更新までを一括で行う:

```bash
npx shadcn@latest init -d
```

> `-d` は base color = **Neutral**、CSS variables 有効のデフォルト構成で初期化する。
> 実行後 `package.json` には `shadcn` 本体に加えて `class-variance-authority` /
> `clsx` / `tailwind-merge` / `lucide-react` / `tw-animate-css` などが追加される。

ベースカラーやスタイルを対話的に選びたい場合は `-d` を外して実行する:

```bash
npx shadcn@latest init
```

> 対話項目・選択肢は shadcn のバージョンで変わる。表示されたプロンプトに従って選択する
> （base color の選択が中心）。特にこだわりがなければ上記の `-d` で十分。

---

## Step 3: `next.config.ts` に standalone 出力を追加

Dockerfile で standalone モードを使うために、`next.config.ts` を編集して `output: 'standalone'` を追加する。

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

> `output: "standalone"` により、Next.js は実際に必要な `node_modules` だけを抽出した
> 自己完結バンドルを `.next/standalone/` に生成する。
> これにより Docker イメージサイズが 1.5GB → 約 200MB に削減できる。

---

## Step 4: Dockerfile の作成

プロジェクトルートに `Dockerfile` を作成する:

```dockerfile
# Stage 1: 依存関係のインストール
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: ビルド
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: 本番実行
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# セキュリティ: root以外のユーザーで実行
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

プロジェクトルートに `.dockerignore` を作成する:

```
node_modules
.next
.git
*.md
.env*
!.env.example
```

---

## Step 5: AGENTS.md の作成

プロジェクトルートに `AGENTS.md` を作成する。

**まず既存内容を確認すること。** create-next-app のテンプレートや既存リポジトリには、
すでに `<!-- BEGIN:nextjs-agent-rules -->` 〜 `<!-- END:nextjs-agent-rules -->` の
ブロックが含まれている場合がある。その場合は**上書きせずスキップ**する（既存の注意書きを
壊さない）。ブロックが無ければ以下を作成、`AGENTS.md` 自体が無ければ新規作成する:

```markdown
<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->
```

---

## Step 6: GitHub Actions CI ワークフローの作成

`.github/workflows/ci.yml` を作成する（ディレクトリがなければ作成）:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    name: Type check / Lint / Build
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Build
        run: npm run build
        env:
          NEXT_TELEMETRY_DISABLED: 1
```

---

## 完了確認

すべてのステップが終わったら、以下で動作確認を促す:

```bash
# 開発サーバーの起動確認
npm run dev

# フォーマットチェック
npm run format:check

# Docker ビルドの確認（Docker が使える環境の場合）
docker build -t my-nextjs-app .
```

作成・変更したファイルの一覧をユーザーに伝えてセットアップ完了を報告する。
