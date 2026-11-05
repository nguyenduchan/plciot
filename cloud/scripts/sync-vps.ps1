#Requires -Version 5.1
<#
.SYNOPSIS
  Đồng bộ code local → VPS rồi cập nhật Docker (không qua GitHub).

.EXAMPLE
  .\cloud\scripts\sync-vps.ps1
  .\cloud\scripts\sync-vps.ps1 -Build
  .\cloud\scripts\sync-vps.ps1 -Service haproxy

.NOTES
  Setup 1 lần / PC: .\cloud\scripts\setup-dev-pc.ps1 -Test
  Cần Host plciot-vps trong ~/.ssh/config (xem ssh-config.example).
#>
param(
  [string] $Target = $(if ($env:PLCIOT_VPS) { $env:PLCIOT_VPS } else { 'plciot-vps' }),
  [string] $RemotePath = $(if ($env:PLCIOT_VPS_PATH) { $env:PLCIOT_VPS_PATH } else { '/root/plciot' }),
  [string] $Service = '',
  [switch] $Build,
  [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

$paths = @('cloud', 'webapp', 'packages/security')
foreach ($p in $paths) {
  if (-not (Test-Path (Join-Path $repo $p))) { throw "Thiếu thư mục: $p" }
}

$excludes = @(
  '--exclude=cloud/.env',
  '--exclude=cloud/config/passwd',
  '--exclude=cloud/app/data',
  '--exclude=cloud/app/node_modules',
  '--exclude=packages/security/node_modules',
  '--exclude=node_modules',
  '--exclude=.git'
)

$composeArgs = @('up', '-d')
if ($Build) { $composeArgs += '--build' }
if ($Service) { $composeArgs += $Service }
$composeLine = 'docker compose ' + ($composeArgs -join ' ')

Write-Host "==> Sync $repo -> ${Target}:$RemotePath"
Write-Host "==> Remote: $composeLine"
if ($WhatIf) { exit 0 }

$tgz = Join-Path $env:TEMP 'plciot-sync.tgz'
$sh = Join-Path $env:TEMP 'plciot-sync.sh'
try {
  Write-Host '==> Dong goi...'
  & tar @(@('-C', $repo, '-czf', $tgz) + $excludes + $paths)
  if ($LASTEXITCODE -ne 0) { throw "tar that bai ($LASTEXITCODE)" }

  $remoteSh = @"
#!/bin/bash
set -euo pipefail
mkdir -p '$RemotePath'
cd '$RemotePath'
tar xzf /tmp/plciot-sync.tgz
# Bo CRLF (file sync tu Windows)
find cloud -type f \( -name '*.sh' -o -name '*.cfg' \) -exec perl -pi -e 's/\r\n/\n/g; s/\r/\n/g' {} + 2>/dev/null || true
chmod +x cloud/config/haproxy-entrypoint.sh 2>/dev/null || true
cd cloud
echo '==> $composeLine'
$composeLine
docker compose ps
rm -f /tmp/plciot-sync.tgz /tmp/plciot-sync.sh
"@
  $remoteSh = $remoteSh -replace "`r`n", "`n" -replace "`r", "`n"
  [IO.File]::WriteAllText($sh, $remoteSh)

  Write-Host '==> scp...'
  & scp -o BatchMode=yes $tgz "${Target}:/tmp/plciot-sync.tgz"
  if ($LASTEXITCODE -ne 0) { throw "scp tgz that bai ($LASTEXITCODE)" }
  & scp -o BatchMode=yes $sh "${Target}:/tmp/plciot-sync.sh"
  if ($LASTEXITCODE -ne 0) { throw "scp sh that bai ($LASTEXITCODE)" }

  Write-Host '==> ssh update...'
  & ssh -o BatchMode=yes $Target 'bash /tmp/plciot-sync.sh'
  if ($LASTEXITCODE -ne 0) { throw "ssh update that bai ($LASTEXITCODE)" }
  Write-Host '==> Xong.'
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tgz, $sh
}
