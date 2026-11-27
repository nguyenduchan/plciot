<#
.SYNOPSIS
  Đưa khoá ký gói GatewayApp (~/.plciot/gw-sign.pem) lên VPS /root/.plciot/gw-sign.pem — CHẠY MỘT LẦN trên máy đang giữ khoá.
  Sau đó publish-gateway.ps1 / sync-vps.ps1 trên MỌI PC ký gói trên VPS: PC build không cần khoá, không cần node.

.DESCRIPTION
  - Kiểm khoá công khai của file khớp một khoá trong tools/GatewayApp/UpdateSignature.cs (TrustedKeys) — sai khoá thì dừng.
  - Chép qua scp vào /root/.plciot (chmod 700/600, chủ root), NGOÀI /root/plciot (sync không ghi đè) và ngoài container app.
  - Kiểm lại trên VPS: ký thử trong container --network none và so khoá công khai.
  - Không xoá khoá trên máy này: vẫn nên giữ một bản SAO LƯU ngoài VPS (USB) — mất khoá = gateway đang chạy không nhận bản mới.

.EXAMPLE
  .\cloud\scripts\push-gw-key-vps.ps1
  .\cloud\scripts\push-gw-key-vps.ps1 -Key D:\usb\gw-sign.pem
#>
param(
  [string] $Key = $(if ($env:GW_SIGN_KEY) { $env:GW_SIGN_KEY } else { Join-Path $env:USERPROFILE '.plciot\gw-sign.pem' }),
  [string] $VpsHost = 'plciot-vps',
  [switch] $Overwrite   # VPS đã có khoá KHÁC: chỉ ghi đè khi chắc chắn
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path $Key)) { throw "Khong thay khoa $Key (may nay khong giu khoa ky gateway?)" }
$trusted = Get-Content (Join-Path $repo 'tools\GatewayApp\UpdateSignature.cs') -Raw

# khoá công khai của file — tính trên VPS (container không mạng) để máy này không cần node/openssl
$tmp = "/tmp/gwkey-" + [guid]::NewGuid().ToString('N').Substring(0, 12)
ssh $VpsHost "umask 077 && mkdir -p $tmp"
if ($LASTEXITCODE) { throw 'ssh VPS loi' }
scp -q $Key "${VpsHost}:$tmp/key.pem"
if ($LASTEXITCODE) { ssh $VpsHost "rm -rf $tmp"; throw 'scp loi' }
$sh = @"
set -e
trap 'rm -rf $tmp' EXIT
PUB=`$(docker run --rm --network none --entrypoint node -e GW_SIGN_KEY=/k/key.pem -v $($tmp)/key.pem:/k/key.pem:ro -w /app plciot-app scripts/sign-gateway-release.js --pub)
echo "PUB=`$PUB"
if [ -f /root/.plciot/gw-sign.pem ]; then
  OLD=`$(docker run --rm --network none --entrypoint node -e GW_SIGN_KEY=/k/key.pem -v /root/.plciot/gw-sign.pem:/k/key.pem:ro -w /app plciot-app scripts/sign-gateway-release.js --pub)
  echo "OLD=`$OLD"
fi
if [ "`$1" = install ]; then
  mkdir -p /root/.plciot && chmod 700 /root/.plciot
  install -m 600 -o root -g root $tmp/key.pem /root/.plciot/gw-sign.pem
  echo INSTALLED
fi
"@ -replace "`r", ''
function Invoke-Remote([string] $arg) {
  $local = Join-Path ([IO.Path]::GetTempPath()) ("gwkey-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".sh")
  [IO.File]::WriteAllText($local, $sh, (New-Object Text.UTF8Encoding $false))
  scp -q $local "${VpsHost}:$tmp.sh"; $rc = $LASTEXITCODE; Remove-Item $local
  if ($rc) { throw 'scp lenh len VPS loi' }
  $o = ssh $VpsHost "bash $tmp.sh $arg; rc=`$?; rm -f $tmp.sh; exit `$rc"
  if ($LASTEXITCODE) { throw "Lenh tren VPS loi ($LASTEXITCODE)" }
  return $o
}

# lượt 1: chỉ đọc khoá công khai (chưa cài) — trap xoá $tmp nên chép lại cho lượt cài
$o = Invoke-Remote 'check'
$pub = ($o | Where-Object { $_ -like 'PUB=*' } | Select-Object -First 1) -replace '^PUB=', ''
$old = ($o | Where-Object { $_ -like 'OLD=*' } | Select-Object -First 1) -replace '^OLD=', ''
if (-not $pub) { throw 'Khong doc duoc khoa cong khai (file khong phai khoa EC PEM?)' }
if (-not $trusted.Contains('"' + $pub + '"')) { throw "Khoa ($($pub.Substring(0, 24))...) KHONG nam trong UpdateSignature.TrustedKeys - gateway se tu choi goi ky bang khoa nay. Dung lai." }
if ($old -and $old -eq $pub) { Write-Host "VPS da co dung khoa nay ($($pub.Substring(0, 24))...). Khong lam gi." -ForegroundColor Green; return }
if ($old -and -not $Overwrite) { throw "VPS dang co khoa KHAC ($($old.Substring(0, 24))...). Kiem tra lai; chac chan thi chay voi -Overwrite." }

ssh $VpsHost "umask 077 && mkdir -p $tmp"
scp -q $Key "${VpsHost}:$tmp/key.pem"
if ($LASTEXITCODE) { ssh $VpsHost "rm -rf $tmp"; throw 'scp loi' }
$o = Invoke-Remote 'install'
if (-not ($o -contains 'INSTALLED')) { throw 'Cai khoa tren VPS khong thanh cong' }
Write-Host "Da dua khoa ky gateway ($($pub.Substring(0, 24))...) len ${VpsHost}:/root/.plciot/gw-sign.pem (600, root)." -ForegroundColor Green
Write-Host 'Tu gio publish-gateway.ps1 / sync-vps.ps1 tren moi PC ky goi tren VPS. Giu ban sao luu khoa ngoai VPS (USB).'
