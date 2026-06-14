# spec: 自己署名コードサイニング (#61)

| 項目 | 値 |
|---|---|
| issue | #61 自分用で使う環境では自己署名で起動を容易にする |
| ステータス | 実装中 (feat/61-self-sign) |
| 関連 | [todo.md §I](todo.md) (コードサイニング決定) / #62 (インストーラ対応, 別 issue) |

## 1. 目的とスコープ

現状 `release.yml` が出力する EXE は **完全に未署名**で、Windows では SmartScreen /
「発行元不明」警告が出る。本対応のゴールは **開発者自身の Windows PC で、自分が
ビルドした EXE を警告なく起動できる**ようにすること。

- **やる**: `release.yml` のビルド成果物 (portable EXE) を CI 上で自己署名する。
- **やらない (別 issue)**: 公的 CA / EV 証明書による「第三者にも警告が出ない」署名は
  コスト見合いで v1 対象外 (todo.md §I のまま)。インストーラ (#62) 内に展開される
  アプリ EXE への署名順序の作り込みは #62 着手時に確定する。

## 2. 前提となる Windows の挙動 (重要)

- 自己署名証明書は「作っただけ」では警告は消えない。**その証明書を信頼ストア
  (信頼されたルート + 信頼された発行元) に登録した PC でのみ**警告が消える。
- したがって本機能は「自分の PC 限定」。Releases から落とす第三者には、証明書を
  手動で信頼しない限り未署名同様の警告が出る (#61 は "自分用" 前提なので想定通り)。
- 署名にはタイムスタンプ (RFC3161) を併用する。これにより証明書の有効期限が切れた
  後も、期限内に行われた既存署名は失効しない。

## 3. 構成

```
開発者の Windows PC (一度だけ)                GitHub Actions (release.yml, v* タグ毎)
─────────────────────────────              ────────────────────────────────────
scripts/new-signing-cert.ps1                wails build → build/bin/*.exe
  1. 自己署名 CodeSigning 証明書を作成         ↓
  2. この PC の Root + TrustedPublisher に登録  Set-AuthenticodeSignature (SHA256 + TS)
  3. .pfx を base64 で書き出す                  ↓ (Secrets 未設定なら自動スキップ)
        │                                     署名済み EXE を Releases にアップロード
        ▼                                              │
  GitHub Secrets に登録:                                ▼
   WINDOWS_SIGN_PFX_BASE64                       開発者 PC で DL → 警告なく起動
   WINDOWS_SIGN_PFX_PASSWORD                     (手順 1-2 で証明書を信頼済みのため)
```

## 4. ワンタイム・セットアップ手順 (開発者)

> 自分の **Windows** PC の PowerShell で実行する (WSL からではない)。

1. リポジトリ直下で:
   ```powershell
   pwsh -File scripts/new-signing-cert.ps1
   ```
   - 自己署名証明書を作成し、この PC の信頼ストアに登録。
   - `.pfx` を保護するパスワードを聞かれるので入力。
   - 出力は `.local-signing/` (`.gitignore` 済み)。**秘密鍵を含むのでコミット厳禁**。
2. GitHub: repo → Settings → Secrets and variables → Actions → New repository secret
   - `WINDOWS_SIGN_PFX_BASE64` = `.local-signing/image-observer-signing.pfx.base64.txt` の中身
   - `WINDOWS_SIGN_PFX_PASSWORD` = 手順 1 で入力したパスワード
3. 以降 `v*` タグ push で出る EXE は自己署名される。自分の PC では警告なく起動する。

## 5. CI 署名ステップ (release.yml)

- `Detect signing secret` ステップで `WINDOWS_SIGN_PFX_BASE64` **と** `WINDOWS_SIGN_PFX_PASSWORD`
  の両方が揃っているかを判定し、`signcheck.outputs.enabled` に反映。base64 だけ設定され
  パスワードが欠けている場合は warning を出して署名をスキップする (後段の例外回避)。
- `Sign Windows artifacts` ステップは `enabled == 'true'` のときだけ実行。
  - base64 から空白/改行を除去 (`-replace '\s',''`) してから `.pfx` を復元し、
    `X509Certificate2` で読み込む。`.pfx` は `try/finally` で必ず削除する。
  - `build/bin/*.exe` を `Set-AuthenticodeSignature -HashAlgorithm SHA256` で署名。
  - タイムスタンプサーバは **https を優先し http にフォールバック**して順に試行
    (1 つ失敗しても次へ)。RFC3161 のタイムスタンプトークンは TSA 署名済みで
    改ざん検知可能なため http も許容。
  - 署名の成否は **署名者証明書の thumbprint 一致 + タイムスタンプ付与**で検証
    (CI ランナーは自己署名証明書を信頼していないため `Status` は当てにしない)。
- **Secrets 未設定なら署名ステップはスキップ**され、未署名のままリリースは継続する
  (証明書未整備でもリリースが壊れない / fork でも動く)。

## 6. カバレッジと限界

| 対象 | 状態 |
|---|---|
| portable EXE (`image-observer.exe`) | ✅ CI で署名 (本対応のメイン) |
| NSIS インストーラ本体 | △ `build/bin/*.exe` に含まれれば署名されるが、現状 release.yml はインストーラ未出力。本格対応は #62 |
| インストーラが展開する**インストール後**のアプリ EXE | ✖ 署名前にパッケージされるため未署名。#62 で「EXE 署名 → パッケージング」の順序を確定する |
| 第三者の PC での警告解消 | ✖ 自己署名のため対象外 (公的 CA 署名は別途) |

## 7. 運用メモ

- **証明書の更新**: 期限切れが近づいたら `scripts/new-signing-cert.ps1` を再実行し、
  Secrets を更新する。タイムスタンプ済みの過去リリースは失効しない。
- **検証**: 署名済み EXE は `Get-AuthenticodeSignature .\image-observer.exe` で確認。
  自 PC では `Status = Valid`、未信頼 PC では `UnknownError` (= 署名はあるが未信頼)。
- **秘密鍵の扱い**: `.local-signing/` と `.pfx` は Git 管理外。漏えい時は証明書を
  作り直し、旧証明書を信頼ストアから削除する。自己署名・自分用なので影響範囲は
  「その証明書を信頼した自分の PC」に限定される。

## 8. DoD

- [ ] `release.yml` に署名ステップを追加 (Secrets 未設定で自動スキップ)
- [ ] `scripts/new-signing-cert.ps1` で証明書作成 + 自 PC 信頼 + .pfx 出力ができる
- [ ] `.local-signing/` を `.gitignore` に追加
- [ ] todo.md §I のコードサイニング項目を #61 反映で更新
- [ ] (開発者手作業) Secrets 登録後、`v*` タグで出た EXE が自 PC で警告なく起動
