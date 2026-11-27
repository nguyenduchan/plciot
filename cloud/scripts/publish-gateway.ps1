#Requires -Version 5.1
<#
.SYNOPSIS
  Build GatewayApp -> releases/gateway (zip + manifest.json). sync-vps.ps1 gọi bước này rồi đẩy releases/ lên VPS;
  gateway thấy manifest.version khác version.txt của mình thì hiện nút "Cập nhật".
.NOTES
  Version = băm nội dung các file build (không phụ thuộc thời điểm build): build lại mà code không đổi thì version giữ nguyên.
  Bản framework-dependent (cần .NET 8 Desktop Runtime — máy gateway đang chạy app là đã có).
#>
param([switch] $Force)
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
# Ký gói (khoá ~/.plciot/gw-sign.pem hoặc GW_SIGN_KEY, NGOÀI repo): gateway từ chối gói không có chữ ký khớp UpdateSignature.TrustedKeys
$signJs = Join-Path $repo 'cloud\app\scripts\sign-gateway-release.js'
$signed = & node $signJs sign $zip $version $apiLevel
if ($LASTEXITCODE -ne 0) { Remove-Item -Force $zip; throw "Ky goi gateway that bai - can khoa ~/.plciot/gw-sign.pem (chep tu may phat hanh) hoac chay sync-vps -SkipGateway" }
$signed = $signed | ConvertFrom-Json
$trusted = Get-Content (Join-Path $repo 'tools\GatewayApp\UpdateSignature.cs') -Raw
if (-not $trusted.Contains('"' + $signed.pub + '"')) { Remove-Item -Force $zip; throw "Khoa ky ($($signed.pub.Substring(0,24))...) khong nam trong UpdateSignature.TrustedKeys - gateway se tu choi goi nay" }
$man = [ordered]@{ version = $version; apiLevel = $apiLevel; file = $zipName; sha256 = $signed.sha256; sig = $signed.sig; size = (Get-Item $zip).Length; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText($manPath, ($man | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Remove-Item -Recurse -Force $stage
Write-Host ("==> Gateway {0} ({1} MB) -> {2}" -f $version, [math]::Round($man.size / 1MB, 1), $out)
