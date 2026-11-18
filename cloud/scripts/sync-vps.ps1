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
  [switch] $WhatIf,
  [switch] $SkipGateway   # bỏ bước build GatewayApp (nút Cập nhật của gateway)
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

New-Item -ItemType Directory -Force (Join-Path $repo 'releases') | Out-Null   # releases/ bị gitignore: PC mới chưa có thì tạo trước khi kiểm tra
$paths = @('cloud', 'webapp', 'solutions', 'packages/security', 'releases')
foreach ($p in $paths) {
  if (-not (Test-Path (Join-Path $repo $p))) { throw "Thiếu thư mục: $p" }
}

if (-not $SkipGateway -and -not $WhatIf) {
  # Gateway tự hỏi VPS có bản mới không: build ở máy lập trình rồi đẩy kèm (releases/gateway/manifest.json + zip).
  try { & (Join-Path $PSScriptRoot 'publish-gateway.ps1') }
  catch { Write-Warning "Bo qua build gateway: $($_.Exception.Message) (dung -SkipGateway de tat buoc nay)" }
}
New-Item -ItemType Directory -Force (Join-Path $repo 'releases\gateway') | Out-Null

$excludes = @(
  '--exclude=cloud/.env',
  '--exclude=cloud/config/passwd',
  '--exclude=cloud/config/acl',
  '--exclude=cloud/config/acl-monitor',
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
export COMPOSE_BAKE=false   # VPS chưa có buildx: Bake làm build lỗi và để container app ở trạng thái Created
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
  # Docker ghi cảnh báo ra stderr; với 'Stop' PowerShell 5.1 coi đó là lỗi và ngắt ssh giữa lúc build → chỉ xét mã thoát.
  $ErrorActionPreference = 'Continue'
  & ssh -o BatchMode=yes $Target 'bash /tmp/plciot-sync.sh' 2>&1 | ForEach-Object { "$_" }
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw "ssh update that bai ($LASTEXITCODE)" }
  # Kiểm sau deploy: server phải phát đúng bản gateway vừa đẩy lên (cùng/ cao hơn apiLevel). Sai → bản gateway mới cần server mới: chạy lại với -Build.
  $manFile = Join-Path $repo 'releases\gateway\manifest.json'
  if ((Test-Path $manFile) -and -not $Service) {
    $want = Get-Content $manFile -Raw | ConvertFrom-Json
    $got = $null
    for ($i = 0; $i -lt 8 -and -not $got; $i++) {
      Start-Sleep -Seconds 3
      $raw = & ssh -o BatchMode=yes $Target 'curl -s http://127.0.0.1:3080/api/gateway/update' 2>$null
      try { $got = $raw | ConvertFrom-Json } catch { $got = $null }
    }
    if (-not $got -or -not $got.version) { Write-Warning "Server khong tra ban gateway ($raw). Neu bao server_outdated: ban gateway can server moi hon -> chay lai voi -Build." }
    elseif ($got.version -ne $want.version) { Write-Warning "Server dang phat gateway $($got.version), khac ban vua build $($want.version)." }
    else { Write-Host "==> Gateway $($got.version) (apiLevel $($got.apiLevel), server $($got.serverApiLevel)) san sang de cap nhat." }
  }
  Write-Host '==> Xong.'
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tgz, $sh
}
