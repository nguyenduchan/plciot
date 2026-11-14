<#
 Kéo bản sao lưu DB mới nhất từ VPS về MÁY NÀY (bản ngoài VPS, phòng khi hỏng/mất VPS).
   .\cloud\scripts\pull-backup.ps1               # kéo bản mới nhất, kiểm tra trước và sau khi kéo
   .\cloud\scripts\schedule-pull-backup.ps1      # đặt lịch Windows chạy mỗi tuần
 Bản lưu: %USERPROFILE%\plciot-backups\app-auto-YYYYMMDD.db (chứa băm mật khẩu + bí mật TOTP: đừng chia sẻ, nên đặt thư mục được mã hoá/BitLocker).

 Kiểm tra:
   1. TRƯỚC khi kéo: trên VPS chạy verify-backup.js (PRAGMA integrity_check, đếm dòng) — hỏng thì dừng, không ghi đè bản tốt.
   2. SAU khi kéo: kích thước file phải bằng kích thước trên VPS.
 Ghi nhật ký vào %USERPROFILE%\plciot-backups\pull-backup.log.
#>
param([string]$Dest = (Join-Path $env:USERPROFILE 'plciot-backups'), [int]$Keep = 8, [string]$Vps = 'plciot-vps')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null
$log = Join-Path $Dest 'pull-backup.log'
function Log($m) { $l = "$(Get-Date -Format 's') $m"; Add-Content -Path $log -Value $l; $l }
try {
  $latest = (ssh $Vps "ls -1 /root/plciot/cloud/app/data/backups/app-auto-*.db 2>/dev/null | tail -1").Trim()
  if (-not $latest) { throw 'Chưa có bản sao lưu tự động trên VPS (app tạo bản đầu sau ~1 phút khi khởi động).' }
  $name = Split-Path $latest -Leaf
  $v = ssh $Vps "docker exec plciot-app node scripts/verify-backup.js /app/data/backups/$name"
  if ($LASTEXITCODE -ne 0) { throw "Bản sao lưu trên VPS KHÔNG đạt kiểm tra: $v" }
  Log "VPS verify: $v"
  $size = [int64](ssh $Vps "stat -c %s $latest")
  $target = Join-Path $Dest $name
  scp -C "${Vps}:$latest" "$target.part"
  if ($LASTEXITCODE -ne 0) { throw "scp lỗi ($LASTEXITCODE)" }
  if ((Get-Item "$target.part").Length -ne $size) { Remove-Item "$target.part" -Force; throw "Kích thước sau khi kéo không khớp ($size byte trên VPS)." }
  Move-Item "$target.part" $target -Force
  Get-ChildItem $Dest -Filter 'app-auto-*.db' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
  Log "OK: $target ($([math]::Round($size/1MB,1)) MB)"
} catch { Log "LỖI: $($_.Exception.Message)"; throw }
