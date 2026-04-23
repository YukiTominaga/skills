---
name: flutter-firebase-line-login
description: Flutter アプリに Firebase Authentication の OIDC プロバイダ経由で LINE ログインを実装するスキル。flutter_line_sdk で LINE ネイティブ SDK を呼び、取得した ID Token を Firebase の signInWithCredential に渡す方式。rawNonce の SHA-256 ハッシュ化（Apple 互換仕様）、Firebase Console の Implicit flow 設定、LINE Developers Console のパッケージ署名（openssl sha1 形式）、AndroidManifest の taskAffinity 削除など、ハマりポイントが多い組み合わせ。「LINE ログイン」「LINE Login」「flutter_line_sdk」「Firebase OIDC」「missing-or-invalid-nonce」「invalid-cert-hash」「LINE アプリから戻らない」などの話題で必ず使用すること。
---

# Flutter × Firebase Auth × LINE Login 実装

Flutter アプリで Firebase Authentication の OIDC プロバイダ経由で LINE ログインを実現する手順。
Firebase が標準で用意している `signInWithProvider`（Chrome Custom Tabs 経由の Web フロー）は Android で `Unable to process request due to missing initial state` エラーが出るため、**flutter_line_sdk でネイティブにログインし、取得した ID Token を `signInWithCredential` で Firebase に渡す**方式を採用する。

## 全体像

```
[Flutter アプリ]
  └─ flutter_line_sdk.login() … LINE アプリ/Web で認証
       └─ result.accessToken.data['id_token']
            └─ OAuthProvider('oidc.line').credential(idToken, rawNonce)
                 └─ FirebaseAuth.signInWithCredential() … Firebase 側で検証・サインイン
```

---

## 1. 依存パッケージ

`pubspec.yaml`:

```yaml
dependencies:
  firebase_core: ^4.x
  firebase_auth: ^6.x
  flutter_line_sdk: ^2.7.2
  crypto: ^3.0.6   # nonce を SHA-256 ハッシュするため
```

---

## 2. main.dart での SDK 初期化

```dart
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_line_sdk/flutter_line_sdk.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await LineSDK.instance.setup('YOUR_LINE_CHANNEL_ID'); // LINE Developers の Channel ID
  runApp(const ProviderScope(child: App()));
}
```

---

## 3. AuthRepository の実装（肝）

```dart
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_line_sdk/flutter_line_sdk.dart';

class AuthRepository {
  AuthRepository(this._auth);
  final FirebaseAuth _auth;

  Future<void> signInWithLine() async {
    // 1. 生の nonce を生成
    final rawNonce = _generateNonce();
    // 2. LINE には SHA-256 ハッシュ済みの nonce を渡す
    final hashedNonce = sha256.convert(utf8.encode(rawNonce)).toString();

    // 3. LINE SDK でログイン（LoginOption の第1引数 false = LINE アプリ優先）
    final option = LoginOption(false, 'normal')..idTokenNonce = hashedNonce;
    final result = await LineSDK.instance.login(
      scopes: ['profile', 'openid', 'email'],
      option: option,
    );

    // 4. ID Token を取り出す
    final idToken = result.accessToken.data['id_token'] as String?;
    if (idToken == null) throw Exception('LINE ID token not found');

    // 5. Firebase には「生の」rawNonce を渡す
    //    Firebase が内部で SHA-256(rawNonce) == id_token.nonce を検証する
    final credential = OAuthProvider('oidc.line').credential(
      idToken: idToken,
      rawNonce: rawNonce,
    );
    await _auth.signInWithCredential(credential);
  }

  Future<void> signOut() async {
    try {
      await LineSDK.instance.logout();
    } catch (_) {
      // LINE 未ログイン状態などは無視
    }
    await _auth.signOut();
  }

  String _generateNonce([int length = 32]) {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    final random = Random.secure();
    return List.generate(length, (_) => chars[random.nextInt(chars.length)])
        .join();
  }
}
```

### なぜ nonce をハッシュする必要があるか

Firebase Auth の `OAuthProvider.credential(rawNonce: ...)` は **Apple Sign-In 互換の仕様**で実装されている。
つまり Firebase サーバー側で `SHA-256(rawNonce) == id_token.nonce` を検証する。

一方、LINE は OIDC 標準どおり、受け取った nonce をそのまま id_token.nonce に入れる。
したがって「LINE にはハッシュ済みの値を渡し、Firebase には生の値を渡す」という対応が必要。

この対応をしないと `[firebase_auth/missing-or-invalid-nonce] SHA256 hash of the raw nonce does not match ...` エラーが出る。

---

## 4. AndroidManifest.xml の修正

Flutter のデフォルトテンプレートには `android:taskAffinity=""` が入っているが、これがあると **LINE アプリから Flutter アプリに戻れない**（ログイン後 LINE のチャット画面が表示されたまま）。

`android/app/src/main/AndroidManifest.xml`:

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTop"
    <!-- ▼ この行を削除する -->
    <!-- android:taskAffinity="" -->
    android:theme="@style/LaunchTheme"
    ...>
```

LINE SDK はパッケージ名（taskAffinity のデフォルト値）でホストアプリのタスクを解決して戻ろうとするため、空文字にするとタスクを特定できなくなる。

LINE SDK 自身のアクティビティは AAR のマニフェストマージで自動登録されるので、手動で追加する必要はない。

---

## 5. Firebase Console 設定

### 5-1. OIDC プロバイダ追加

`Authentication → Sign-in method → 新しいプロバイダを追加 → OpenID Connect`

| 項目 | 値 |
|------|-----|
| Grant type | **Implicit flow (id_token)** |
| Name | `LINE`（任意、Provider ID は `oidc.line` になる） |
| Client ID | LINE の Channel ID |
| Issuer (URL) | `https://access.line.me` |
| Client secret | LINE の Channel secret |

> **重要**: Grant type は必ず `Implicit flow (id_token)` にする。`Code flow` だと `signInWithCredential(idToken)` 方式で動かない。

### 5-2. Android アプリの SHA 証明書登録

`プロジェクトの設定 → マイアプリ → Android アプリ → SHA 証明書フィンガープリント`

デバッグキーストアの SHA-1 を登録する：

```bash
keytool -list -v \
  -keystore ~/.android/debug.keystore \
  -alias androiddebugkey \
  -storepass android -keypass android
```

登録後、**`google-services.json` を再ダウンロード** して `android/app/` に上書きする。
これをしないと Firebase が Android アプリを認識できずログイン自体が失敗する。

---

## 6. LINE Developers Console 設定

### 6-1. Android プラットフォーム設定

LINE Developers Console → 対象チャネル → **LINE Login 設定** → **Android** セクション

| 項目 | 取得コマンド / 値 |
|------|-------|
| パッケージ名 | `android/app/build.gradle.kts` の `applicationId` |
| パッケージの署名 | 下記コマンドの出力（40 文字の小文字 hex、コロンなし） |

```bash
# デバッグ署名
keytool -exportcert \
  -alias androiddebugkey \
  -keystore ~/.android/debug.keystore \
  -storepass android -keypass android \
  2>/dev/null | openssl sha1
```

出力例: `SHA1(stdin)= d67e22387145aad896b1afe6fd1add6c6fc7b15d`

**ハッシュ値部分だけ**（`d67e...7b15d`）をコピペする。

### 重要: パッケージ署名のフォーマット

LINE Developers Console は **`openssl sha1` が出力する形式の SHA-1** を要求する。
`keytool -list -v` が表示する `SHA1:` や `SHA256:` 行とは別物。以下のいずれかを入力すると「有効な SHA ハッシュ値を入力してください」で弾かれる：

- SHA-256（64 文字）
- コロン付き（`D6:7E:...`）
- 大文字（`D67E22...`）

正しい形式は **40 文字・小文字・コロンなし**。

### 6-2. Android URL スキーム

LINE SDK はパッケージ名 + 署名でホストアプリを解決するため、**URL スキームの設定は不要**。空欄のままで動く。

---

## 7. 動作確認チェックリスト

- [ ] `flutter pub get` 後にフル再起動（ホットリロード不可、SDK 初期化を再実行するため）
- [ ] LINE ログインボタン押下 → LINE アプリが開く
- [ ] LINE アプリで承認 → Flutter アプリに自動で戻る
- [ ] Firebase Authentication のユーザー一覧に LINE ユーザーが追加される
- [ ] `user.displayName` に LINE の表示名が入っている

---

## 8. よくあるエラーと原因

| エラー | 原因 | 対処 |
|--------|------|------|
| `invalid-cert-hash` | LINE Developers Console にパッケージ署名が未登録 | `openssl sha1` 形式で登録 |
| `missing-or-invalid-nonce` (SHA256 hash ... does not match) | LINE に生の nonce を渡している | `sha256.convert(utf8.encode(rawNonce))` をハッシュ済みとして渡す |
| `Unable to process request due to missing initial state` | `signInWithProvider` の Web フローを使っている | `flutter_line_sdk` + `signInWithCredential` に切り替える |
| LINE アプリから戻らない | `taskAffinity=""` が残っている | AndroidManifest から削除 |
| Firebase の Android アプリが認識されない | SHA-1 未登録、または google-services.json が古い | Firebase Console に SHA-1 登録 → JSON 再ダウンロード |
| LINE Console が SHA 値を弾く | `keytool -list -v` の値を使っている | `keytool -exportcert ... \| openssl sha1` の値を使う |

---

## 9. リリースビルド時の注意

デバッグキーストアと本番キーストアは別物なので、本番リリース時は以下を追加登録する：

1. 本番キーストアの SHA-1 を `openssl sha1` で取得 → LINE Developers Console に追加（既存に改行区切りで追記可）
2. 本番キーストアの SHA-1 を Firebase Console に追加 → `google-services.json` 再ダウンロード
3. Google Play アプリ署名を使う場合は、Play Console の「アプリ署名」から取得した SHA-1 も同様に登録

---

## 10. iOS 対応（参考）

iOS でも同じコードが動くが、以下の追加設定が必要：

- `ios/Runner/Info.plist` に LINE URL スキーム `line3rdp.<bundle_id>` を登録
- `LSApplicationQueriesSchemes` に `line` `lineauth2` を追加
- LINE Developers Console → iOS 設定に Bundle ID と URL スキームを登録

詳細な Info.plist / AppDelegate のサンプルは `reference.md` 参照。

---

## 詳細リファレンス

以下の情報が必要になったら `reference.md` を参照:

- 公式ドキュメントの URL 一覧
- nonce 検証仕様の詳細（OIDC 標準 vs Firebase の Apple 互換仕様）
- Android 署名フィンガープリントの種類と取得コマンドの比較
- LINE Login Scopes / LoginOption / LoginResult の構造
- iOS 対応の Info.plist / AppDelegate.swift サンプル
- Firebase Auth / LINE SDK のエラーコード一覧
- トラブルシュート時のデバッグ手法（画面表示デバッグ・JWT nonce デコード）
- signInWithProvider 方式がダメな理由の詳細
