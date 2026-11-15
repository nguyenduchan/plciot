#Requires -Version 5.1
<#
.SYNOPSIS
  Chỉ đồng bộ thư mục solutions/ lên VPS (không build, không restart). Server tự nhận thư mục mới/đổi
  (bundle người dùng cập nhật trong vài giây). Mục tự xuất hiện trong ô chọn ở admin.
#>
param(
  [string] $Target = $(if ($env:PLCIOT_VPS) { $env:PLCIOT_VPS } else { 'plciot-vps' }),
  [string] $RemotePath = $(if ($env:PLCIOT_VPS_PATH) { $env:PLCIOT_VPS_PATH } else { '/root/plciot' }),
  [switch] $WhatIf
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $repo 'solutions'))) { throw 'Thiếu thư mục solutions/' }
Write-Host "==> $repo\solutions -> ${Target}:$RemotePath/solutions"
if ($WhatIf) { exit 0 }
$tgz = Join-Path $env:TEMP 'plciot-solutions.tgz'
try {
  & tar -C $repo -czf $tgz --exclude=bin --exclude=obj solutions
  if ($LASTEXITCODE -ne 0) { throw "tar thất bại ($LASTEXITCODE)" }
  & scp -q $tgz "${Target}:/tmp/plciot-solutions.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'scp thất bại' }
  & ssh $Target "set -e; mkdir -p $RemotePath; tar -xzf /tmp/plciot-solutions.tgz -C $RemotePath; rm -f /tmp/plciot-solutions.tgz; ls $RemotePath/solutions"
  if ($LASTEXITCODE -ne 0) { throw 'giải nén trên VPS thất bại' }
  Write-Host '==> Xong. Mục tự xuất hiện trong ô chọn của admin.'
} finally { Remove-Item $tgz -ErrorAction SilentlyContinue }
