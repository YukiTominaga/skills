---
name: identity-platform-cloudrun-auth
description: Next.js App Router アプリケーションに Google Identity Platform（Firebase Auth）を使ったユーザーログインを実装し、Cloud Run で動作させるスキル。Firebase Client SDK でのサインイン、Firebase Admin SDK によるセッションクッキー発行、ADC（Application Default Credentials）を活用した Cloud Run 向け認証情報管理、requireAuth/requireRole によるルート保護、Docker ビルド引数設定を扱う。「Identity Platform」「Firebase Auth」「Cloud Run 認証」「セッションクッキー」「requireAuth」「ADC」などのキーワードで使用すること。
---

# Identity Platform × Cloud Run 認証実装

Next.js App Router + Cloud Run 構成で Google Identity Platform（Firebase Auth）によるログインを実装するパターン。

## アーキテクチャ概要

```
[ブラウザ]
  └─ signInWithEmailAndPassword (Firebase Client SDK)
       └─ getIdToken()
            └─ loginAction (Server Action)
                 ├─ verifyIdToken (Firebase Admin SDK) ← Identity Platform でユーザー存在確認
                 └─ createSessionCookie → httpOnly Cookie 発行 (14日)
```

ユーザーの存在確認は **Identity Platform のトークン検証のみ**で行う。DB 参照は不要。
ロールなどの追加属性が必要な場合は Firebase **カスタムクレーム**に格納し、セッションクッキーから読み取る。

---

## 1. 依存パッケージ

```bash
npm install firebase firebase-admin
```

---

## 2. 環境変数

### `.env.example`

```bash
# Firebase Client SDK（NEXT_PUBLIC_* = ビルド時に焼き込み）
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=

# パスワードリセットメールのリダイレクト先（/reset-password ページの絶対 URL）
NEXT_PUBLIC_RESET_PASSWORD_URL=

# GCP プロジェクト ID（Admin SDK の初期化に使用）
PROJECT_ID=
```

> サービスアカウント鍵ファイルは使用しない。
> **ローカル開発**: `gcloud auth application-default login` で ADC を設定する。
> **Cloud Run 本番**: 実行サービスアカウントが ADC として自動的に使われる。

---

## 3. Firebase Client SDK（`src/lib/firebase-client.ts`）

```typescript
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

export function getFirebaseApp(): FirebaseApp {
  if (getApps().length === 0) return initializeApp(firebaseConfig);
  return getApp();
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}
```

---

## 4. Firebase Admin SDK（`src/lib/firebase-admin.ts`）

**常に ADC を使用する**。サービスアカウント鍵ファイルは使わない。

- ローカル: `gcloud auth application-default login` で設定した ADC が使われる
- Cloud Run: 実行サービスアカウントが ADC として自動適用される

```typescript
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

if (getApps().length === 0) {
  // credential を指定しない → ADC（Application Default Credentials）を自動使用
  initializeApp({ projectId: process.env.PROJECT_ID });
}

export function getFirebaseAuth() {
  return getAuth();
}
```

---

## 5. セッション管理（`src/lib/auth.ts`）

- セッションクッキー名: `session`、有効期限: **14日**
- `getCurrentUser()` はセッションクッキーを検証し、**デコードされたトークンのクレームからユーザー情報を取得**（DB 参照なし）
- ロールは Identity Platform の**カスタムクレーム**から読み取る

```typescript
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getFirebaseAuth } from "./firebase-admin";
import type { DecodedIdToken } from "firebase-admin/auth";

const SESSION_COOKIE_NAME = "session";
const SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export interface SessionData {
  uid: string;
  email: string;
  role: string; // カスタムクレームの値。アプリ固有の型を定義してもよい
}

export async function createSessionCookie(idToken: string): Promise<string> {
  const auth = getFirebaseAuth();
  return auth.createSessionCookie(idToken, { expiresIn: SESSION_EXPIRY_MS });
}

export async function verifySessionCookie(
  cookie: string,
): Promise<DecodedIdToken | null> {
  try {
    return await getFirebaseAuth().verifySessionCookie(cookie, true);
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) return null;

  const decodedToken = await verifySessionCookie(sessionCookie);
  if (!decodedToken) return null;

  // ユーザー情報はトークンクレームから取得（DB 参照なし）
  return {
    uid: decodedToken.uid,
    email: decodedToken.email ?? "",
    role: (decodedToken.role as string) ?? "",
  };
}

interface RequireAuthOptions {
  redirect?: boolean;
}

export async function requireAuth(
  options: RequireAuthOptions = {},
): Promise<SessionData> {
  const user = await getCurrentUser();
  if (!user) {
    if (options.redirect === false)
      throw new UnauthorizedError("認証が必要です");
    redirect("/login");
  }
  return user;
}

export async function requireRole(
  roles: string | string[],
  options: RequireAuthOptions = {},
): Promise<SessionData> {
  const user = await getCurrentUser();
  if (!user) {
    if (options.redirect === false)
      throw new UnauthorizedError("認証が必要です");
    redirect("/login");
  }
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  if (!allowedRoles.includes(user.role)) {
    if (options.redirect === false)
      throw new ForbiddenError("アクセス権限がありません");
    redirect("/403");
  }
  return user;
}
```

---

## 6. 認証 Server Action（`src/actions/auth.ts`）

```typescript
"use server";

import { cookies } from "next/headers";
import { getUserForLogin, createSession } from "@/services/authService";

const SESSION_COOKIE_NAME = "session";

export async function loginAction(idToken: string): Promise<AuthResult> {
  try {
    // Identity Platform でトークン検証（ユーザーが存在しない・無効なら例外）
    const { decodedToken } = await getUserForLogin(idToken);
    const sessionCookie = await createSession(idToken);

    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // 本番のみ secure
      sameSite: "lax",
      maxAge: 14 * 24 * 60 * 60,
      path: "/",
    });

    return {
      success: true,
      user: {
        uid: decodedToken.uid,
        email: decodedToken.email ?? "",
        role: (decodedToken.role as string) ?? "",
      },
    };
  } catch (error) {
    return { success: false, error: "認証に失敗しました" };
  }
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: SESSION_COOKIE_NAME, path: "/" });
}
```

---

## 7. 認証サービス（`src/services/authService.ts`）

IDトークンを検証し、**Identity Platform 上のユーザー存在確認のみ**行う。DB 参照は不要。

```typescript
import { createSessionCookie } from "@/lib/auth";
import { getFirebaseAuth } from "@/lib/firebase-admin";
import type { DecodedIdToken } from "firebase-admin/auth";

export async function getUserForLogin(
  idToken: string,
): Promise<{ decodedToken: DecodedIdToken }> {
  const auth = getFirebaseAuth();
  // Identity Platform でトークンを検証（失効・無効なら例外がスローされる）
  const decodedToken = await auth.verifyIdToken(idToken, true);
  return { decodedToken };
}

export async function createSession(idToken: string): Promise<string> {
  return createSessionCookie(idToken);
}
```

> ロール制御が必要な場合は、Identity Platform のコンソールまたは Admin SDK の `setCustomUserClaims()` でカスタムクレームを事前に設定しておく。
> ログイン時に `decodedToken.role` などで参照できる。

---

## 8. ログインフォーム（`src/components/auth/LoginForm.tsx`）

```typescript
"use client";

import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";
import { loginAction } from "@/actions/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";

export function LoginForm() {
  const router = useRouter();

  async function onSubmit(data: { email: string; password: string }) {
    // 1. Firebase Client SDK でサインイン
    const auth = getFirebaseAuth();
    const credential = await signInWithEmailAndPassword(
      auth,
      data.email,
      data.password,
    );
    const idToken = await credential.user.getIdToken();

    // 2. Server Action でセッションクッキーを発行
    const result = await loginAction(idToken);
    if (!result.success) {
      // エラー表示
      return;
    }

    // 3. リダイレクト
    router.push("/dashboard");
    router.refresh();
  }
  // ...
}
```

---

## 9. パスワードリセット

### フロー

```
[/forgot-password]
  └─ sendPasswordResetEmail(auth, email, { url: NEXT_PUBLIC_RESET_PASSWORD_URL })
       └─ Firebase がリセットメールを送信
            └─ メール内リンク → /auth/action?mode=resetPassword&oobCode=xxxx&apiKey=...
                 （Firebase カスタムアクション URL に /auth/action を設定しているため）

[/auth/action?mode=resetPassword&oobCode=xxxx]
  ├─ verifyPasswordResetCode(auth, oobCode)  ← コード有効性確認
  └─ confirmPasswordReset(auth, oobCode, newPassword)  ← パスワードを更新
```

> **カスタムアクション URL について**
> Firebase のカスタムアクション URL はプロジェクト全体で 1 つだけ設定でき、`mode` パラメータで
> `resetPassword` / `verifyEmail` / `recoverEmail` を区別する。
> `/auth/action` を振り分けハブにすることで将来の拡張に対応できる。

### 環境変数

パスワードリセットに追加の環境変数は不要。  
カスタムアクション URL は Firebase Console のみで設定する（コードに持たせない）。

### Firebase Console の設定

Firebase Console（または Identity Platform コンソール）で以下を設定する:

1. **Authentication → Templates → パスワードのリセット** の編集画面を開く
2. 「**アクション URL をカスタマイズ**」をクリック
3. カスタムアクション URL に設定:
   - 本番: `https://your-app.example.com/auth/action`
   - ローカル: `http://localhost:3000/auth/action`
4. **承認済みドメイン** に本番 URL（例: `your-app.example.com`）を追加

### アクションハブページ（`app/auth/action/page.tsx`）

`mode` パラメータで各コンポーネントに振り分ける。将来 `verifyEmail` などを追加する場合もここに `else if` を足す。

```typescript
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import Link from "next/link";
import { Suspense } from "react";

interface PageProps {
  searchParams: Promise<{ mode?: string }>;
}

export default async function AuthActionPage({ searchParams }: PageProps) {
  const { mode } = await searchParams;

  if (mode === "resetPassword") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              パスワードの再設定
            </h1>
          </div>
          <Suspense fallback={<p className="text-center text-sm text-muted-foreground">確認中…</p>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">無効なリンク</h1>
        <p className="text-sm text-muted-foreground">このリンクは無効か、有効期限が切れています。</p>
        <Link href="/login" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          ログインへ
        </Link>
      </div>
    </div>
  );
}
```

### パスワード再発行フォーム（`components/auth/ForgotPasswordForm.tsx`）

```typescript
'use client';
import { sendPasswordResetEmail } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase-client';

async function onSubmit(email: string) {
  // url オプション（continueUrl）は不要。カスタムアクション URL は Firebase Console で設定する
  await sendPasswordResetEmail(getFirebaseAuth(), email);
}
```

### パスワード再設定フォーム（`components/auth/ResetPasswordForm.tsx`）

URL クエリパラメータ `oobCode` を使用。マウント時に Firebase でコードを検証する（外部システムとの同期なので `useEffect` が適切）。

```typescript
'use client';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getFirebaseAuth } from '@/lib/firebase-client';

export function ResetPasswordForm() {
  const oobCode = useSearchParams().get('oobCode');
  const [isValidCode, setIsValidCode] = useState<boolean | null>(null);

  // Firebase のリセットコード（外部システム）を検証する副作用
  useEffect(() => {
    if (!oobCode) { setIsValidCode(false); return; }
    verifyPasswordResetCode(getFirebaseAuth(), oobCode)
      .then(() => setIsValidCode(true))
      .catch(() => setIsValidCode(false));
  }, [oobCode]);

  async function onSubmit(newPassword: string) {
    if (!oobCode || !isValidCode) return;
    await confirmPasswordReset(getFirebaseAuth(), oobCode, newPassword);
    // ログインページへリダイレクト
  }
}
```

> `oobCode` が無効・期限切れなら `verifyPasswordResetCode` が例外をスローする。エラー時は `/forgot-password` へ誘導する。  
> `ResetPasswordForm` は `useSearchParams()` を使うため `<Suspense>` でラップする（`/auth/action` ページ側でラップする）。

---

## 10. 保護されたルート（`src/app/(protected)/layout.tsx`）

```typescript
import { requireAuth } from '@/lib/auth';

// cookies() を使うため force-dynamic 必須
export const dynamic = 'force-dynamic';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  await requireAuth(); // 未認証 → /login にリダイレクト
  return <>{children}</>;
}
```

Server Action / API Route でのロール保護:

```typescript
// ページを問わない（リダイレクトせず 401/403 を返す）
const user = await requireAuth({ redirect: false }); // 未認証 → UnauthorizedError
const user = await requireRole("ADMIN", { redirect: false }); // 権限不足 → ForbiddenError
```

---

## 10. Dockerfile（ビルド引数でクライアント変数を焼き込む）

```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app

# NEXT_PUBLIC_* はビルド時に静的に埋め込まれるため ARG → ENV が必要
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID

ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
```

> `PROJECT_ID` はランタイム環境変数として Cloud Run マニフェストで渡す。ビルド引数に含めても問題ないが機密情報ではない。

---

## 12. Cloud Run サービスアカウント（ADC として機能）

```yaml
# google-cloud/service.yaml（抜粋）
spec:
  template:
    spec:
      serviceAccountName: your-app@your-project.iam.gserviceaccount.com # ← この SA が ADC として機能
      containers:
        - env:
            - name: PROJECT_ID
              value: your-project
```

**必要な IAM ロール（実行サービスアカウントに付与）**:

| ロール                                                            | 用途                                               |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| `roles/firebaseauth.admin` または `Firebase Authentication Admin` | セッションクッキー作成・検証、カスタムクレーム設定 |
| `roles/iam.serviceAccountTokenCreator`                            | ADC でのトークン取得（自分自身に付与の場合もある） |

---

## チェックリスト

### ローカル開発

- [ ] `gcloud auth application-default login` を実行して ADC を設定
- [ ] `.env.local` に `NEXT_PUBLIC_FIREBASE_*`・`PROJECT_ID` を設定
- [ ] Identity Platform で「メール/パスワード」プロバイダを有効化
- [ ] Identity Platform コンソールで承認済みドメインにアプリの URL を追加
- [ ] Firebase Console → Authentication → Templates → パスワードのリセット → カスタムアクション URL を `http://localhost:3000/auth/action` に設定
- [ ] ロール制御が必要な場合は対象ユーザーにカスタムクレーム（例: `{ role: "ADMIN" }`）を設定

### Cloud Run デプロイ

- [ ] Docker ビルド引数に `NEXT_PUBLIC_FIREBASE_*` を渡す
- [ ] Cloud Run マニフェストに `PROJECT_ID` をランタイム環境変数として設定
- [ ] Cloud Run 実行サービスアカウントに `roles/firebaseauth.admin` を付与
- [ ] Firebase Console → Authentication → Templates → パスワードのリセット → カスタムアクション URL を本番 URL（`https://your-app.example.com/auth/action`）に変更

---

## よくある問題

| 症状                              | 原因と対処                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createSessionCookie` が失敗      | Admin SDK が初期化されていない、または実行 SA に権限がない                                       |
| ローカルで Admin SDK が認証エラー | `gcloud auth application-default login` が未実行 → 実行して ADC を設定する                       |
| `verifySessionCookie` が常に null | Cookie が `httpOnly` のため JS から見えない。Network タブで `session` クッキーの有無を確認       |
| ロールが空文字になる              | カスタムクレームが未設定。Admin SDK の `setCustomUserClaims(uid, { role: '...' })` で設定する    |
| ロール変更が反映されない          | セッションクッキーは発行時のクレームを保持する。再ログインまたはセッションを破棄して再認証が必要 |
| Cloud Run で ADC が効かない       | 実行 SA に `roles/firebaseauth.admin` が付与されているか確認                                     |
| リセットメールのリンクで `The selected page mode is invalid` | Firebase の hosted action handler（`firebaseapp.com/__/auth/action`）に `apiKey` が渡らない。Firebase Console でカスタムアクション URL（`/auth/action`）を設定する |
| リセットメール内リンクが直接 Firebase のページに飛ぶ | カスタムアクション URL が未設定。Firebase Console → Authentication → Templates → パスワードのリセット → アクション URL をカスタマイズ |

## 関連ファイル

詳細な実装例は [reference.md](reference.md) を参照。
