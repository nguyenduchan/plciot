<#
 Kéo bản sao lưu DB mới nhất từ VPS về MÁY NÀY (bản ngoài VPS, phòng khi hỏng/mất VPS).
 Chạy tay hoặc đặt lịch Windows (Task Scheduler) mỗi tuần:
   .\cloud\scripts\pull-backup.ps1
 Bản lưu: %USERPROFILE%\plciot-backups\app-auto-YYYYMMDD.db (file chứa băm mật khẩu + bí mật TOTP: đừng chia sẻ, nên đặt thư mục được mã hoá/BitLocker).
#>
param([string]$Dest = (Join-Path $env:USERPROFILE 'plciot-backups'), [int]$Keep = 8)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null
$latest = (ssh plciot-vps "ls -1 /root/plciot/cloud/app/data/backups/app-auto-*.db 2>/dev/null | tail -1").Trim()
if (-not $latest) { throw 'Chưa có bản sao lưu tự động trên VPS (app tạo bản đầu sau ~1 phút khi khởi động).' }
$name = Split-Path $latest -Leaf
scp "plciot-vps:$latest" (Join-Path $Dest $name)
if ($LASTEXITCODE -ne 0) { throw "scp lỗi ($LASTEXITCODE)" }
Get-ChildItem $Dest -Filter 'app-auto-*.db' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
"OK: $(Join-Path $Dest $name) ($([math]::Round((Get-Item (Join-Path $Dest $name)).Length/1KB)) KB)"
