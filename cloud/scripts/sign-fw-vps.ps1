<#
.SYNOPSIS
  Ký firmware board Waveshare KÊNH DEV bằng khoá nằm trên VPS (/root/.plciot/fw-sign-dev.pem, ngoài container app)
  và đưa lên /root/plciot/releases/mcu-dev. PC dev KHÔNG giữ khoá: ai có SSH vào VPS thì phát hành bản dev được.

  Firmware dev (env waveshare-dev) tin khoá này qua FW_DEV_PUBKEY2. Bản PHÁT HÀNH chính thức vẫn ký bằng khoá trên PC
  (~/.plciot/fw-sign.pem, sign-mcu-firmware.js) — script này từ chối phiên bản không có đuôi -dev.

  Ký chạy trong container dùng một lần (--network none, khoá gắn chỉ đọc) — tiến trình app đang chạy không đọc được khoá.
  Bản trước được sao lưu vào /root/plciot/releases/mcu-dev-bak/<giờ>/.

.EXAMPLE
  .\cloud\scripts\sign-fw-vps.ps1 -Bin gateway-mcu\.pio\build\waveshare-dev\firmware.bin -Version mcu-0.4.17-dev -Notes "Sửa ..."
#>
param(
  [Parameter(Mandatory)][string]$Bin,
  [Parameter(Mandatory)][string]$Version,
  [string]$Notes = '',
  [string]$VpsHost = 'plciot-vps'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^mcu-[0-9A-Za-z._]{1,24}-dev$') { throw "Chỉ ký kênh dev: phiên bản phải dạng mcu-x.y.z-dev (nhận: $Version)" }
if (-not (Test-Path $Bin)) { throw "Không thấy $Bin" }
$tmp = "/tmp/fwsign-" + [guid]::NewGuid().ToString('N').Substring(0, 12)
$notesB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Notes))

ssh $VpsHost "mkdir -p $tmp && chmod 700 $tmp"
if ($LASTEXITCODE) { throw 'ssh lỗi' }
scp -q $Bin "${VpsHost}:$tmp/firmware.bin"
if ($LASTEXITCODE) { throw 'scp lỗi' }

$remote = @"
set -e
K=/root/.plciot/fw-sign-dev.pem; D=/root/plciot/releases/mcu-dev
[ -f "`$K" ] || { echo "Thiếu khoá `$K trên VPS"; exit 3; }
if [ -f "`$D/manifest.json" ]; then B=/root/plciot/releases/mcu-dev-bak/`$(date +%Y%m%d-%H%M%S); mkdir -p "`$B"; cp -a "`$D"/. "`$B"/; echo "Sao lưu bản trước: `$B"; fi
NOTES=`$(echo '$notesB64' | base64 -d)
docker run --rm --network none --entrypoint node -e FW_SIGN_KEY=/k/key.pem \
  -v "`$K":/k/key.pem:ro -v $($tmp):/in -v "`$D":/out -w /app plciot-app \
  scripts/sign-mcu-firmware.js sign /in/firmware.bin '$Version' --notes "`$NOTES" --out /out
rm -rf $tmp
echo "pub: `$(grep -o '"pub": *"[^"]*"' "`$D/manifest.json")"
"@
$remote = $remote -replace "`r", ''
# chạy bằng FILE (UTF-8 không BOM, chép lên bằng scp), không qua tham số/stdin: PowerShell 5.1 làm hỏng dấu " khi truyền tham số sang ssh
# ("unexpected EOF while looking for matching") và chèn BOM khi pipe ("﻿set: command not found").
$local = Join-Path ([IO.Path]::GetTempPath()) ("fwsign-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".sh")
[IO.File]::WriteAllText($local, $remote, (New-Object Text.UTF8Encoding $false))
scp -q $local "${VpsHost}:$tmp/run.sh"
Remove-Item $local
if ($LASTEXITCODE) { throw 'scp lỗi' }
ssh $VpsHost "bash $tmp/run.sh"
if ($LASTEXITCODE) { throw "Ký trên VPS lỗi ($LASTEXITCODE)" }
Write-Host "Đã ký $Version bằng khoá VPS và đưa lên kênh dev." -ForegroundColor Green
