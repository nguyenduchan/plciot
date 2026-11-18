#Requires -Version 5.1
<#
.SYNOPSIS
  Thử giao diện GatewayApp của từng giải pháp bằng dữ liệu THẬT từ PlcSim (không cần PLC, không đụng cấu hình gateway thật).

.DESCRIPTION
  Mỗi giải pháp: một PlcSim với hồ sơ riêng (cổng Modbus TCP riêng) → PlcSim ghi cấu hình gateway thử (Pack khớp D, giao diện ui.json)
  rồi mở GatewayApp --noauth --solshot: gateway đọc PlcSim qua Modbus, chụp window.png + page.png và ghi state.txt (running=…).
  Chạy song song theo lô; kết quả ở thư mục -Out (mặc định %TEMP%\plciot-uitest).

.EXAMPLE
  dotnet build tools/PlcSim; dotnet build tools/GatewayApp
  .\tools\solution-kit\plcsim-uitest.ps1                     # mọi giải pháp
  .\tools\solution-kit\plcsim-uitest.ps1 -Ids boiler,water   # vài giải pháp
#>
param(
  [string[]] $Ids = @(),
  [string] $Out = (Join-Path $env:TEMP 'plciot-uitest'),
  [int] $Parallel = 6,
  [int] $BasePort = 15100
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sim = Get-ChildItem (Join-Path $repo 'tools\PlcSim\bin') -Recurse -Filter PlcSim.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $sim) { throw 'Chưa build PlcSim: dotnet build tools/PlcSim' }
if (-not (Get-ChildItem (Join-Path $repo 'tools\GatewayApp\bin') -Recurse -Filter GatewayApp.exe -ErrorAction SilentlyContinue)) { throw 'Chưa build GatewayApp: dotnet build tools/GatewayApp' }
if ($Ids.Count -eq 0) { $Ids = Get-ChildItem (Join-Path $repo 'solutions') -Directory | Where-Object { $_.Name -notlike '_*' -and (Test-Path (Join-Path $_.FullName 'gateway\setup.json')) } | ForEach-Object Name }

New-Item -ItemType Directory -Force $Out | Out-Null
$i = 0; $procs = @()
foreach ($id in $Ids) {
  $d = Join-Path $Out $id
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  New-Item -ItemType Directory -Force (Join-Path $d 'sim') | Out-Null
  $env:PLCSIM_SETTINGS = Join-Path $d 'sim\settings.json'
  $port = $BasePort + $i
  $procs += Start-Process -FilePath $sim.FullName -PassThru -ArgumentList @('--solution', $id, '--modbus-port', $port, '--gateway', "`"--noauth --solshot $d`"", '--exit-with-gateway')
  $i++
  if ($procs.Count -ge $Parallel) { $procs | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue; $procs = @() }
}
if ($procs.Count) { $procs | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue }
Remove-Item Env:PLCSIM_SETTINGS -ErrorAction SilentlyContinue

$bad = 0
foreach ($id in $Ids) {
  $st = Join-Path $Out "$id\state.txt"
  $line = if (Test-Path $st) { Get-Content $st -Raw -Encoding UTF8 } else { 'KHÔNG CÓ KẾT QUẢ' }
  if ($line -notmatch 'running=True') { $bad++ }
  '{0,-11} {1}' -f $id, $line.Trim()
}
"==> Ảnh: $Out\<giải pháp>\window.png, page.png"
if ($bad) { Write-Warning "$bad giải pháp gateway không chạy được"; exit 1 }
