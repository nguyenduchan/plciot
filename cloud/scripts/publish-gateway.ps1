#Requires -Version 5.1
<#
.SYNOPSIS
  Build GatewayApp -> releases/gateway (zip + manifest.json). sync-vps.ps1 gọi bước này rồi đẩy releases/ lên VPS;
  gateway thấy manifest.version khác version.txt của mình thì hiện nút "Cập nhật".
.NOTES
  Version = băm nội dung các file build (không phụ thuộc thời điểm build): build lại mà code không đổi thì version giữ nguyên.
  Bản framework-dependent (cần .NET 8 Desktop Runtime — máy gateway đang chạy app là đã có).
#>
param(
  [switch] $Force,
  [switch] $LocalSign,               # ký bằng khoá trên máy này (cần node + ~/.plciot/gw-sign.pem); mặc định ký trên VPS
  [string] $VpsHost = 'plciot-vps'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $repo 'releases\gateway'
$stage = Join-Path $env:TEMP 'plciot-gateway-publish'
New-Item -ItemType Directory -Force $out | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }

Write-Host '==> dotnet publish GatewayApp'
& dotnet publish (Join-Path $repo 'tools\GatewayApp\GatewayApp.csproj') -c Release -o $stage --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "dotnet publish that bai ($LASTEXITCODE)" }
# server.json là của từng máy khách (đổi được mà không build lại) → không nằm trong gói cập nhật
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $stage 'server.json'), (Join-Path $stage 'version.txt')

$sha = [Security.Cryptography.SHA256]::Create()
function Get-Hex([byte[]] $b) { [BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').ToLowerInvariant() }
$sb = New-Object Text.StringBuilder
Get-ChildItem $stage -Recurse -File | Sort-Object { $_.FullName.Substring($stage.Length).ToLowerInvariant() } | ForEach-Object {
  $rel = $_.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/').ToLowerInvariant()
  [void]$sb.Append($rel + ':' + (Get-Hex ([IO.File]::ReadAllBytes($_.FullName))) + "`n")
}
$version = (Get-Hex ([Text.Encoding]::UTF8.GetBytes($sb.ToString()))).Substring(0, 12)

$apiLevel = [int]([regex]::Match((Get-Content (Join-Path $repo 'tools\GatewayApp\AppUpdate.cs') -Raw), 'ApiLevel\s*=\s*(\d+)').Groups[1].Value)
if ($apiLevel -lt 1) { throw 'Khong doc duoc AppUpdate.ApiLevel' }
$manPath = Join-Path $out 'manifest.json'
if (-not $Force -and (Test-Path $manPath)) {
  $old = Get-Content $manPath -Raw | ConvertFrom-Json
  if ($old.version -eq $version -and $old.sig -and (Test-Path (Join-Path $out $old.file))) { Write-Host "==> Gateway khong doi ($version)"; return }
}

# version.txt nằm TRONG gói: sau khi cập nhật, gateway biết mình đang ở bản nào
[IO.File]::WriteAllText((Join-Path $stage 'version.txt'), $version)
$zipName = "GatewayApp-$version.zip"
$zip = Join-Path $out $zipName
Get-ChildItem $out -Filter 'GatewayApp-*.zip' | Remove-Item -Force
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
# Ký gói: gateway từ chối gói không có chữ ký khớp UpdateSignature.TrustedKeys.
# MẶC ĐỊNH ký TRÊN VPS (khoá /root/.plciot/gw-sign.pem, ngoài repo và ngoài container app): máy build không giữ khoá, không cần node —
# build được trên nhiều PC. Ký trong container dùng một lần (--network none, khoá chỉ đọc), như sign-fw-vps.ps1. Đưa khoá lên VPS một lần:
# cloud/scripts/push-gw-key-vps.ps1 (chạy trên máy đang giữ khoá). -LocalSign: ký bằng khoá ~/.plciot/gw-sign.pem / GW_SIGN_KEY trên máy này.
function Sign-OnVps([string] $zipPath) {
  $tmp = "/tmp/gwsign-" + [guid]::NewGuid().ToString('N').Substring(0, 12)
  ssh $VpsHost "mkdir -p $tmp && chmod 700 $tmp"
  if ($LASTEXITCODE) { throw 'ssh VPS loi' }
  scp -q $zipPath "${VpsHost}:$tmp/pkg.zip"
  if ($LASTEXITCODE) { throw 'scp goi gateway len VPS loi' }
  # lệnh chạy bằng FILE (UTF-8 không BOM): PowerShell 5.1 làm hỏng dấu " khi truyền tham số sang ssh và chèn BOM khi pipe
  $sh = @"
K=/root/.plciot/gw-sign.pem
[ -f "`$K" ] || { echo "Thieu khoa `$K tren VPS - chay cloud/scripts/push-gw-key-vps.ps1 tren may giu khoa" >&2; rm -rf $tmp; exit 3; }
docker run --rm --network none --entrypoint node -e GW_SIGN_KEY=/k/key.pem -v "`$K":/k/key.pem:ro -v $($tmp):/in:ro -w /app plciot-app \
  scripts/sign-gateway-release.js sign /in/pkg.zip $version $apiLevel
rc=`$?; rm -rf $tmp; exit `$rc
"@ -replace "`r", ''
  $local = Join-Path ([IO.Path]::GetTempPath()) ("gwsign-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".sh")
  [IO.File]::WriteAllText($local, $sh, (New-Object Text.UTF8Encoding $false))
  scp -q $local "${VpsHost}:$tmp/run.sh"; $rcScp = $LASTEXITCODE
  Remove-Item $local
  if ($rcScp) { throw 'scp lenh ky len VPS loi' }
  $outp = ssh $VpsHost "bash $tmp/run.sh"
  if ($LASTEXITCODE) { throw "Ky tren VPS loi ($LASTEXITCODE)" }
  return ($outp | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
}
try {
  if ($LocalSign) {
    $signed = & node (Join-Path $repo 'cloud\app\scripts\sign-gateway-release.js') sign $zip $version $apiLevel
    if ($LASTEXITCODE -ne 0) { throw 'can khoa ~/.plciot/gw-sign.pem va node tren may nay' }
  } else {
    Write-Host "==> Ky goi gateway $version tren VPS ($VpsHost)"
    $signed = Sign-OnVps $zip
  }
  $signed = $signed | ConvertFrom-Json
  if (-not $signed.sig) { throw 'khong nhan duoc chu ky' }
} catch { Remove-Item -Force $zip; throw "Ky goi gateway that bai: $($_.Exception.Message) (hoac chay sync-vps -SkipGateway)" }
$trusted = Get-Content (Join-Path $repo 'tools\GatewayApp\UpdateSignature.cs') -Raw
if (-not $trusted.Contains('"' + $signed.pub + '"')) { Remove-Item -Force $zip; throw "Khoa ky ($($signed.pub.Substring(0,24))...) khong nam trong UpdateSignature.TrustedKeys - gateway se tu choi goi nay" }
$man = [ordered]@{ version = $version; apiLevel = $apiLevel; file = $zipName; sha256 = $signed.sha256; sig = $signed.sig; size = (Get-Item $zip).Length; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText($manPath, ($man | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Remove-Item -Recurse -Force $stage
Write-Host ("==> Gateway {0} ({1} MB) -> {2}" -f $version, [math]::Round($man.size / 1MB, 1), $out)
