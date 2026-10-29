# Cấu hình gửi email qua Gmail cho cloud (OTP email, khôi phục tài khoản).
# Chạy trong PowerShell tại thư mục cloud:   powershell -ExecutionPolicy Bypass -File scripts\set-smtp.ps1
# Mật khẩu ứng dụng chỉ nhập tại đây (ẩn khi gõ), được ghi vào cloud/.env (đã .gitignore) và không in ra màn hình.
param(
  [string]$Email = 'nguyen.duc.han.1704@gmail.com'
)
$ErrorActionPreference = 'Stop'
$cloud = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $cloud '.env'
if (-not (Test-Path $envFile)) { throw "Không thấy $envFile" }

$secure = Read-Host "Dán mật khẩu ứng dụng Gmail (16 ký tự) cho $Email" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBigEndianUni([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$plain = $plain -replace '\s', ''
if ($plain.Length -ne 16) { throw 'Mật khẩu ứng dụng Gmail gồm 16 ký tự (bỏ khoảng trắng).' }

$user = [Uri]::EscapeDataString($Email)
$pass = [Uri]::EscapeDataString($plain)
$lines = @(
  "SMTP_URL=smtps://${user}:${pass}@smtp.gmail.com:465",
  "MAIL_FROM=`"PLC <$Email>`""
)

# Bỏ dòng SMTP_URL / MAIL_FROM cũ rồi thêm mới, giữ nguyên phần còn lại của .env
$kept = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*(SMTP_URL|MAIL_FROM)\s*=' }
Set-Content -Path $envFile -Value ($kept + $lines) -Encoding utf8
Write-Host "Đã ghi SMTP_URL và MAIL_FROM vào $envFile (không hiện mật khẩu)."

Push-Location $cloud
docker compose up -d --build app
Pop-Location
Write-Host 'Xong. Đăng nhập app → Cài đặt → nhập email để nhận mã xác minh.'
