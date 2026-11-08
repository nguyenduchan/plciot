<#
  Chạy PlcSim (cấu hình mẫu plcsim-settings.json) + Node-RED trong Docker để kiểm tra mô phỏng:
  Modbus TCP (kiểu dữ liệu, struct, quyền, giả lập giá trị) và OPC UA (đồng bộ chéo giao thức).
  .\tools\PlcSim\nodered\run-test.ps1 [-Exe <đường dẫn PlcSim.exe>]
#>
param([string]$Exe = (Join-Path $PSScriptRoot '..\bin\Debug\net8.0-windows\PlcSim.exe'), [string]$Image = 'plciot-edge-nodered:latest')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$work = Join-Path $env:TEMP 'plcsim-nr'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $work | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'flows.json'), (Join-Path $PSScriptRoot 'settings.js') $work
$cfg = Join-Path $work 'plcsim-settings.json'
Copy-Item (Join-Path $PSScriptRoot 'plcsim-settings.json') $cfg   # PlcSim ghi đè file này khi đóng, nên dùng bản sao

$env:PLCSIM_SETTINGS = $cfg
$plc = Start-Process -FilePath (Resolve-Path $Exe) -ArgumentList '--autostart' -PassThru
docker rm -f plcsim-nr 2>$null | Out-Null
docker run -d --name plcsim-nr -e PLC_HOST=host.docker.internal -e PLC_MODBUS_PORT=1502 -e PLC_OPCUA_PORT=4841 -p 11880:1880 -v "${work}:/data" $Image | Out-Null
try {
    $res = Join-Path $work 'result.ndjson'
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep 2
        if ((Test-Path $res) -and @(Get-Content $res).Count -ge 2) { break }
    }
    if (-not (Test-Path $res)) { docker logs plcsim-nr --tail 30; throw 'Node-RED không trả kết quả' }
    $fail = 0
    foreach ($line in Get-Content $res) {
        $r = $line | ConvertFrom-Json
        "== $($r.suite): $($r.passed)/$($r.total) đạt"
        foreach ($t in $r.results) { if (-not $t.ok) { $fail++ }; '  {0} {1}   [{2}]' -f $(if ($t.ok) { 'OK  ' } else { 'LỖI' }), $t.name, $t.detail }
    }
    if ($fail -gt 0) { "TỔNG: $fail kiểm tra lỗi"; exit 1 } else { 'TỔNG: tất cả đạt' }
}
finally {
    docker rm -f plcsim-nr 2>$null | Out-Null
    if (-not $plc.HasExited) { Stop-Process -Id $plc.Id -Force }
}
