#Requires -Version 5.1
<#
.SYNOPSIS
  Phòng thử một giải pháp với live data thật: dựng PlcSim + GatewayApp theo thiết bị/field của giải pháp, gán giải pháp cho một user.
.EXAMPLE
  .\tools\solution-kit\lab.ps1 water            # dựng, chạy PlcSim + GatewayApp, đặt giải pháp cho user (mặc định id 15)
  .\tools\solution-kit\lab.ps1 -Restore         # trả cấu hình PlcSim/gateway về bản gốc và chạy lại
#>
param(
  [Parameter(Position = 0)] [string] $Solution = '',
  [switch] $Restore,
  [int] $UserId = 15,
  [string] $Vps = 'plciot-vps',
  [switch] $NoSetUser
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$py = 'python'
if ($Restore) { & $py (Join-Path $PSScriptRoot 'lab.py') --restore } else {
  if (-not $Solution) { throw 'Cần id giải pháp (vd. water) hoặc -Restore' }
  & $py (Join-Path $PSScriptRoot 'lab.py') $Solution
  if ($LASTEXITCODE -ne 0) { throw 'lab.py lỗi' }
}
Get-Process GatewayApp, PlcSim -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1
$plc = Get-ChildItem (Join-Path $repo 'tools\PlcSim\bin') -Recurse -Filter PlcSim.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$gw = Join-Path $repo 'tools\GatewayApp\bin\basic\GatewayApp.exe'
Start-Process $plc.FullName -ArgumentList '--autostart'
for ($i = 0; $i -lt 20 -and -not (Get-NetTCPConnection -LocalPort 1502 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
Start-Process $gw -ArgumentList '--autostart'
if (-not $Restore -and -not $NoSetUser) {
  # đặt giải pháp cho user (qua admin trên VPS) — webapp của user tự cập nhật ở lần mở kế tiếp
  & ssh $Vps "docker exec -w /app plciot-app node scripts/set_sol.mjs $UserId $Solution" | Select-Object -First 1
}
Write-Host "Đã chạy PlcSim + GatewayApp ($(if ($Restore) { 'cấu hình gốc' } else { $Solution }))."
