<#
  Trình diễn có người "ngồi bấm": PlcSim (trái) tự thêm luồng mực nước + tốc độ bơm, rồi GatewayApp (phải) tự thêm thiết bị tương ứng,
  chạy, và kéo thanh trượt tốc độ bơm. Các cửa sổ mở bằng bản build chỉ định; thao tác chậm để quan sát.
  .\tools\GatewayApp\e2e\run-demo.ps1 [-PlcSim <PlcSim.exe>] [-Gateway <GatewayApp.exe>]
#>
param(
  [string]$PlcSim = (Join-Path $PSScriptRoot '..\..\PlcSim\bin\Debug\net8.0-windows\PlcSim.exe'),
  [string]$Gateway = (Join-Path $PSScriptRoot '..\bin\Debug\net8.0-windows\GatewayApp.exe')
)
$work = Join-Path $env:TEMP 'plciot-autodemo'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $work | Out-Null
$env:AUTODEMO_LOG = Join-Path $work 'demo.log'
$env:PLCSIM_SETTINGS = Join-Path $work 'plcsim.json'
$env:GATEWAYAPP_SETTINGS = Join-Path $work 'gateway.json'
Start-Process (Resolve-Path $Gateway) -ArgumentList '--autodemo'
Start-Sleep 1
Start-Process (Resolve-Path $PlcSim) -ArgumentList '--autodemo'
"Đã mở PlcSim + GatewayApp ở chế độ trình diễn. Nhật ký các bước: $env:AUTODEMO_LOG"
