# 参照実装: Identity Platform × Cloud Run 認証

このプロジェクト（`ctc-recruitment-support`）での実装を参照実装として記録。

## ファイル構成

```
src/
├── lib/
│   ├── firebase-client.ts   # Client SDK（ブラウザ用）
│   ├── firebase-admin.ts    # Admin SDK（サーバー用）
│   └── auth.ts              # requireAuth / requireRole / getCurrentUser
├── services/
│   └── authService.ts       # getUserForLogin / createSession
├── actions/
│   └── auth.ts              # loginAction / logoutAction (Server Actions)
├── components/auth/
│   ├── LoginForm.tsx        # メール/パスワードログインフォーム
│   └── ...
└── app/
    ├── login/page.tsx       # ログインページ（認証済みなら /candidates にリダイレクト）
    ├── (protected)/
    │   └── layout.tsx       # requireAuth() で全保護ルートをガード
    └── 403/page.tsx         # 権限エラーページ

google-cloud/
└── service.dev.yaml         # Cloud Run マニフェスト（SA 指定あり）

Dockerfile                   # ビルド引数で NEXT_PUBLIC_* を焼き込む
```

## ユーザー存在確認の戦略

ユーザーの存在確認は **Identity Platform のトークン検証のみ**で完結する。

- `auth.verifyIdToken(idToken, true)` — IDトークンが有効かつ Identity Platform 上にユーザーが存在する場合のみ成功
- トークンが無効・期限切れ・ユーザー削除済みの場合は例外がスローされ、ログイン失敗として扱われる

## カスタムクレームによるロール管理

ロール（権限）が必要な場合は Identity Platform のカスタムクレームに格納する。

```typescript
// Admin SDK でカスタムクレームを設定（ユーザー招待・ロール変更時に実行）
await getFirebaseAuth().setCustomUserClaims(uid, { role: 'ADMIN' });
```

- セッションクッキーは**発行時点のカスタムクレームを保持**する
- ロール変更を即時反映させるには、対象ユーザーのセッションを破棄して再ログインさせる必要がある
- `verifySessionCookie` で取得した `decodedToken.role` でロールを参照する

## GitHub Actions CD での Docker ビルド

```yaml
# .github/workflows/cd.yaml（抜粋）
- uses: docker/build-push-action@v6
  with:
    build-args: |
      NEXT_PUBLIC_FIREBASE_API_KEY=${{ vars.NEXT_PUBLIC_FIREBASE_API_KEY }}
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${{ vars.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN }}
      NEXT_PUBLIC_FIREBASE_PROJECT_ID=${{ vars.NEXT_PUBLIC_FIREBASE_PROJECT_ID }}
      PROJECT_ID=${{ vars.PROJECT_ID }}
```

Firebase のクライアント向け設定値（API Key など）は秘密情報ではなく GitHub Actions Variables（`vars.*`）で管理。

## ローカル開発時の ADC セットアップ

サービスアカウント鍵ファイルは使用しない。`gcloud` CLI で ADC を設定する。

```bash
# 1. gcloud CLI でログイン（未実施の場合）
gcloud auth login

# 2. ADC を設定（アプリケーションから使われる認証情報）
gcloud auth application-default login

# 3. プロジェクトを設定
gcloud config set project YOUR_PROJECT_ID
```

ADC が正しく設定されていれば、`firebase-admin` は `credential` 指定なしで自動的に認証される。

> **注意**: `~/.config/gcloud/application_default_credentials.json` が生成されるが、`.gitignore` に含まれていることを確認すること（通常はホームディレクトリ配下なので問題ない）。
