<#
.SYNOPSIS
  自分用の自己署名コードサイニング証明書を作成し、この PC で信頼したうえで、
  GitHub Actions (release.yml) が署名に使う .pfx を書き出す。

.DESCRIPTION
  issue #61 のためのワンタイム・セットアップスクリプト。Windows の PowerShell で
  一度だけ実行する (WSL からではなく Windows ネイティブの PowerShell)。

  処理内容:
    1. CurrentUser\My に自己署名コードサイニング証明書 (SHA256) を作成
    2. その公開証明書を CurrentUser\Root + CurrentUser\TrustedPublisher に登録
       → この PC では自己署名された EXE が警告なく起動するようになる
    3. CI 署名用に .pfx (パスワード付き) と、その base64 を書き出す

  自己署名なので「証明書を信頼した PC でだけ」警告が消える。Releases から
  ダウンロードする第三者には未署名同様の警告が出る (#61 は自分用前提)。

  詳細・手順は docs/spec-self-signing.md を参照。

.PARAMETER Subject
  証明書のサブジェクト (発行者名として表示される)。

.PARAMETER OutDir
  .pfx / .cer / base64 の出力先。既定はリポジトリ直下の .local-signing
  (.gitignore 済み — 秘密鍵を含むので絶対にコミットしないこと)。

.PARAMETER Years
  証明書の有効年数。タイムスタンプを併用するため、期限切れ後も既存署名は失効しない。

.EXAMPLE
  pwsh -File scripts/new-signing-cert.ps1
#>
[CmdletBinding()]
param(
  [string]$Subject = 'CN=maretol image-observer (self-signed)',
  [string]$OutDir  = (Join-Path $PSScriptRoot '..\.local-signing'),
  [int]$Years      = 5
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.Platform -eq 'Unix') {
  throw 'このスクリプトは Windows の PowerShell で実行してください (証明書ストア / New-SelfSignedCertificate は Windows 専用)。'
}

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 1. 自己署名コードサイニング証明書を作成 (CurrentUser\My, エクスポート可能)。
Write-Host '[1/4] 自己署名コードサイニング証明書を作成中...'
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears($Years)
Write-Host "      Thumbprint: $($cert.Thumbprint)"

# 2. この PC で信頼する (Root = チェーン信頼 / TrustedPublisher = 発行元不明の抑止)。
Write-Host '[2/4] この PC の信頼ストアに登録中 (CurrentUser Root + TrustedPublisher)...'
$cerPath = Join-Path $OutDir 'image-observer-signing.cer'
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null

# 3. CI 署名用に .pfx を書き出す。
Write-Host '[3/4] CI 用の .pfx をエクスポート中...'
$pfxPass  = Read-Host -AsSecureString 'エクスポートする .pfx を保護するパスワードを入力'
$pfxPath  = Join-Path $OutDir 'image-observer-signing.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPass | Out-Null

# 4. GitHub Secret 用の base64 を書き出す。
Write-Host '[4/4] base64 を書き出し中...'
$b64Path = Join-Path $OutDir 'image-observer-signing.pfx.base64.txt'
[Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath)) | Set-Content -Path $b64Path -NoNewline -Encoding ascii

Write-Host ''
Write-Host '==================== 完了 ====================' -ForegroundColor Green
Write-Host '次の手順:'
Write-Host '  GitHub の repo → Settings → Secrets and variables → Actions に登録:'
Write-Host "    WINDOWS_SIGN_PFX_BASE64   = $b64Path の中身"
Write-Host "    WINDOWS_SIGN_PFX_PASSWORD = いま入力したパスワード"
Write-Host ''
Write-Host "  base64 をクリップボードにコピー:  Get-Content -Raw '$b64Path' | Set-Clipboard"
Write-Host ''
Write-Host "  出力先 ($OutDir) は秘密鍵を含むので Git にコミットしないこと (.gitignore 済み)。"
Write-Host '=============================================' -ForegroundColor Green
