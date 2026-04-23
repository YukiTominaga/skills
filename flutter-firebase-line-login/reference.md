# Reference

## 公式ドキュメント

### Firebase
- [Android OIDC プロバイダでログイン](https://firebase.google.com/docs/auth/android/openid-connect?hl=ja)
- [OAuthProvider.credential (FlutterFire API)](https://pub.dev/documentation/firebase_auth/latest/firebase_auth/OAuthProvider/credential.html)
- [Custom OIDC Providers](https://cloud.google.com/identity-platform/docs/web/custom-provider)

### LINE
- [LINE Login for Android SDK](https://developers.line.biz/ja/docs/line-login-sdks/android-sdk/integrate-line-login/)
- [LINE Login OpenID Connect](https://developers.line.biz/ja/docs/line-login/integrate-line-login/#verify-id-token)
- [LINE Developers Console](https://developers.line.biz/console/)

### パッケージ
- [flutter_line_sdk (pub.dev)](https://pub.dev/packages/flutter_line_sdk)
- [crypto (pub.dev)](https://pub.dev/packages/crypto)

---

## nonce 検証の詳細仕様

### OIDC 標準仕様（LINE の挙動）

1. クライアントが認可リクエストに `nonce=<任意の文字列>` を含める
2. 認可サーバーは **受け取った nonce をそのまま** id_token の `nonce` クレームに入れる
3. クライアントは `id_token.nonce == 送信した nonce` を検証

### Firebase の挙動（Apple Sign-In 互換）

Firebase の `OAuthProvider.credential(rawNonce: X)` は以下を検証する:

```
SHA256(X) == id_token.nonce
```

つまり「rawNonce は送信前にクライアント側で SHA-256 ハッシュ化して認可サーバーに送っているはず」という前提になっている。

### LINE と Firebase の差異を埋める方法

```
rawNonce (32 文字ランダム)
  ├─ SHA-256 → hashedNonce → LINE SDK に渡す
  │                            ↓
  │                          LINE 認可サーバー
  │                            ↓
  │                          id_token.nonce = hashedNonce (そのまま入る)
  └─ そのまま → Firebase に rawNonce として渡す
                  ↓
                Firebase: SHA-256(rawNonce) == id_token.nonce ✓ 一致
```

---

## Android 署名フィンガープリントの種類

| コマンド | 出力形式 | 用途 |
|---------|---------|------|
| `keytool -list -v -keystore ...` | `SHA1: XX:XX:...`（コロン付き大文字） | Firebase Console |
| `keytool -list -v -keystore ...` | `SHA256: XX:XX:...`（コロン付き大文字） | Firebase Console（推奨） |
| `keytool -exportcert ... \| openssl sha1` | `SHA1(stdin)= xxxx...`（コロンなし小文字） | LINE Developers Console |

すべて同じ証明書から生成されるが、**表示形式が異なるだけ**ではなく、**ハッシュ対象のバイト列自体が異なる**場合もあるので、常に公式ドキュメントの取得コマンドを使うこと。

### デバッグキーストアのパス

| OS | パス |
|----|------|
| macOS / Linux | `~/.android/debug.keystore` |
| Windows | `%USERPROFILE%\.android\debug.keystore` |

デバッグキーストアのパスワード・エイリアスは全環境で固定:
- storepass: `android`
- keypass: `android`
- alias: `androiddebugkey`

---

## LINE Login Scopes

| Scope | 取得できる情報 | 必須条件 |
|-------|---------------|---------|
| `profile` | userId, displayName, pictureUrl, statusMessage | なし |
| `openid` | ID Token（Firebase 連携に必須） | なし |
| `email` | email アドレス | LINE Developers でメール取得権限申請が必要 |

本スキルでは `['profile', 'openid', 'email']` を指定している。email が欲しくない場合は外してよい。

---

## LoginOption の引数

`flutter_line_sdk` の `LoginOption` コンストラクタ:

```dart
LoginOption(
  bool onlyWebLogin,     // true: LINE アプリを使わず Web のみ / false: LINE アプリ優先
  String botPrompt,      // 'normal' | 'aggressive' | 'normal' (bot 友だち追加プロンプト)
  {int requestCode = 8192}
)
```

nonce は `LoginOption` インスタンスの `idTokenNonce` プロパティに代入する:

```dart
final option = LoginOption(false, 'normal')..idTokenNonce = hashedNonce;
```

---

## LineSDK.login 戻り値の構造

```dart
result.userProfile?.userId        // LINE userId (U... で始まる文字列)
result.userProfile?.displayName   // 表示名
result.userProfile?.pictureUrl    // プロフィール画像 URL
result.userProfile?.statusMessage // ステメ

result.accessToken.data['access_token']      // LINE access token
result.accessToken.data['id_token']          // OIDC ID Token ← Firebase に渡す
result.accessToken.data['expires_in']        // 有効期限（秒）
result.accessToken.data['refresh_token']     // リフレッシュトークン

result.idTokenNonce               // ログイン時に使用した nonce（検証用）
```

---

## Firebase Console で Client secret が必要な理由

Implicit flow (id_token) でも Firebase Console の UI は Client secret を要求するが、実際の認証フローでは使用されない（`signInWithCredential(idToken)` はクライアントで完結するため）。

ただし将来的に Firebase 側でトークン検証ロジックが変わる可能性もあるので、LINE Developers で発行されたものを正しく入れておくこと。

---

## Firebase Authorized Domains

Firebase Auth の「Authorized Domains」設定に `utaha-io.firebaseapp.com` のようなデフォルトドメインが含まれていれば、本スキルの方式では特に追加は不要。

ただし `signInWithProvider`（非推奨）を使う場合は、LINE のリダイレクト URI が Authorized Domains に含まれている必要がある。

---

## iOS 追加設定の詳細

### Info.plist

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleTypeRole</key>
    <string>Editor</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>line3rdp.YOUR_BUNDLE_ID</string>
    </array>
  </dict>
</array>

<key>LSApplicationQueriesSchemes</key>
<array>
  <string>line</string>
  <string>lineauth2</string>
</array>
```

### AppDelegate.swift

```swift
import LineSDK

func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool {
  return LoginManager.shared.application(app, open: url)
}
```

### LINE Developers Console (iOS 設定)

- Bundle ID: アプリの bundle identifier
- URL Scheme: `line3rdp.<bundle_id>`（Info.plist と揃える）
- Universal Link: 必要に応じて

---

## 関連エラーコードリファレンス

### Firebase Auth エラー

| コード | 意味 |
|-------|------|
| `missing-or-invalid-nonce` | nonce 検証失敗（本スキルの主要テーマ） |
| `invalid-credential` | ID Token が不正（期限切れ・署名検証失敗など） |
| `invalid-custom-token` | Custom Token 方式のときのみ |
| `account-exists-with-different-credential` | 同じ email で別プロバイダのアカウントが既存 |
| `user-disabled` | Firebase Console でユーザーが無効化されている |

### LINE SDK エラー

| コード | 意味 |
|-------|------|
| `invalid-cert-hash` | LINE Developers に登録したパッケージ署名と実機の署名が不一致 |
| `user_cancel` / `ERROR_ABORTED_BY_USER` | ユーザーがログインをキャンセル |
| `authentication_agent_error` | LINE アプリ側の認証エラー |

---

## トラブルシュート時のデバッグ手法

### nonce 値を画面表示する

ログが取れない環境（ワイヤレスデバッグなど）では、エラーメッセージに埋め込んで画面表示するのが有効:

```dart
try {
  final credential = OAuthProvider('oidc.line').credential(
    idToken: idToken,
    rawNonce: rawNonce,
  );
  await _auth.signInWithCredential(credential);
} catch (e) {
  throw Exception(
    'DEBUG\n'
    'raw=$rawNonce\n'
    'hashed=$hashedNonce\n'
    'token_nonce=${_decodeJwtNonce(idToken)}\n'
    'err=$e',
  );
}
```

`_decodeJwtNonce` は JWT のペイロード部分を base64url デコードして `nonce` クレームを取り出すヘルパー。

### 期待値

- `hashed == token_nonce` であれば LINE 側は正常
- Firebase が `SHA256(raw) == token_nonce` で検証するので、`hashed = SHA256(raw)` になっていれば一致する

---

## 参考: signInWithProvider 方式がダメな理由

Firebase の標準的な方法は以下のようにシンプル:

```dart
final provider = OAuthProvider('oidc.line');
await _auth.signInWithProvider(provider);
```

しかし Android では以下の流れになる:
1. Chrome Custom Tabs が開く
2. LINE の認可エンドポイントに遷移
3. LINE がブラウザで認証を要求（LINE アプリ連携なし）
4. 認証後 `https://<project>.firebaseapp.com/__/auth/handler` にリダイレクト
5. handler ページが sessionStorage から state を読み出そうとする
6. **別タブ/別プロセスで sessionStorage が共有されず失敗** → `missing initial state` エラー

flutter_line_sdk + signInWithCredential 方式ならこの問題を完全に回避できる。
