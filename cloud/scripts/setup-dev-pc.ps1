#Requires -Version 5.1
<#
.SYNOPSIS
  Cấu hình 1 lần trên PC Windows (cơ quan hoặc nhà) để code local rồi sync → VPS.

.DESCRIPTION
  - Kiểm tra OpenSSH Client
  - Tạo khoá SSH riêng cho plciot (không đụng khoá khác)
  - Thêm Host plciot-vps vào ~/.ssh/config (nếu chưa có)
  - In public key + lệnh gắn lên VPS
  - (Tuỳ chọn) kiểm tra ssh BatchMode

.EXAMPLE
  .\cloud\scripts\setup-dev-pc.ps1
  .\cloud\scripts\setup-dev-pc.ps1 -VpsIp 14.225.224.218 -Test
#>
param(
  [string] $VpsIp = '14.225.224.218',
  [string] $HostAlias = 'plciot-vps',
  [string] $RemotePath = '/root/plciot',
  [string] $KeyName = 'id_ed25519_plciot',
  [switch] $Test,
  [switch] $ForceConfig
)

$ErrorActionPreference = 'Stop'
$sshDir = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDir $KeyName
$pubPath = "$keyPath.pub"
$configPath = Join-Path $sshDir 'config'

Write-Host '==> PC dev → VPS (plciot)'
Write-Host "    Alias : $HostAlias"
Write-Host "    VPS   : $VpsIp"
Write-Host "    Key   : $keyPath"
Write-Host "    Path  : $RemotePath"

# OpenSSH
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
$scpCmd = Get-Command scp -ErrorAction SilentlyContinue
if (-not $sshCmd -or -not $scpCmd) {
  Write-Host ''
  Write-Host 'Thieu OpenSSH Client. Cai (Admin PowerShell):'
  Write-Host '  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'
  throw 'OpenSSH Client chua cai'
}

if (-not (Test-Path $sshDir)) {
  New-Item -ItemType Directory -Path $sshDir | Out-Null
}

# Key
if (-not (Test-Path $keyPath)) {
  Write-Host "==> Tao khoa $KeyName ..."
  & ssh-keygen -t ed25519 -f $keyPath -N '""' -C "plciot@$env:COMPUTERNAME"
  if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen that bai' }
} else {
  Write-Host "==> Da co khoa: $keyPath"
}

if (-not (Test-Path $pubPath)) { throw "Thieu file pub: $pubPath" }
$pub = (Get-Content $pubPath -Raw).Trim()

# SSH config
$block = @"
Host $HostAlias
  HostName $VpsIp
  User root
  IdentityFile ~/.ssh/$KeyName
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 4
"@

$haveHost = $false
if (Test-Path $configPath) {
  $cfg = Get-Content $configPath -Raw
  if ($cfg -match "(?m)^\s*Host\s+$([regex]::Escape($HostAlias))\s*$") { $haveHost = $true }
}

if ($haveHost -and -not $ForceConfig) {
  Write-Host "==> ~/.ssh/config da co Host $HostAlias (dung -ForceConfig de ghi de block)"
} else {
  if ($haveHost -and $ForceConfig) {
    Write-Host "==> Cap nhat Host $HostAlias trong config (-ForceConfig)"
    $raw = Get-Content $configPath -Raw
    # Xoa block Host cu (toi Host ke tiep hoac EOF)
    $raw = [regex]::Replace($raw, "(?ms)^\s*Host\s+$([regex]::Escape($HostAlias))\s*.*?(?=^\s*Host\s+|\z)", '')
    Set-Content -Path $configPath -Value ($raw.TrimEnd() + "`r`n`r`n" + $block + "`r`n") -Encoding utf8
  } else {
    Write-Host "==> Them Host $HostAlias vao ~/.ssh/config"
    Add-Content -Path $configPath -Value ("`r`n" + $block + "`r`n") -Encoding utf8
  }
}

# Env gợi ý (session hiện tại)
$env:PLCIOT_VPS = $HostAlias
$env:PLCIOT_VPS_PATH = $RemotePath
Write-Host "==> Session env: PLCIOT_VPS=$HostAlias  PLCIOT_VPS_PATH=$RemotePath"

Write-Host ''
Write-Host '========== BUOC BAT BUOC: gan khoa len VPS =========='
Write-Host 'Public key cua PC nay (copy 1 dong):'
Write-Host $pub
Write-Host ''
Write-Host 'Cach A — tu PC DA SSH duoc (vd may co quan), thay PUBKEY bang dong tren:'
Write-Host "  ssh plciot-vps `"mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo 'PUBKEY' >> /root/.ssh/authorized_keys && sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`""
Write-Host ''
Write-Host 'Cach B — tren CHINH PC nay (lan dau, nhap mat khau root 1 lan):'
Write-Host "  type `"$pubPath`" | ssh root@$VpsIp `"mkdir -p .ssh && chmod 700 .ssh && cat >> .ssh/authorized_keys && chmod 600 .ssh/authorized_keys`""
Write-Host ''
Write-Host 'Moi PC: clone/copy repo → setup-dev-pc.ps1 → gan key → code → sync:'
Write-Host '  .\cloud\scripts\sync-vps.ps1'
Write-Host '  .\cloud\scripts\sync-vps.ps1 -Build   # khi doi cloud/app hoac packages/security'
Write-Host '======================================================'

if ($Test) {
  Write-Host ''
  Write-Host "==> Test ssh $HostAlias ..."
  & ssh -o BatchMode=yes -o ConnectTimeout=10 $HostAlias "echo OK; hostname; test -d $RemotePath && echo path_ok || echo path_missing"
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'SSH BatchMode that bai — chua gan public key len VPS, hoac sai Host/Key.' -ForegroundColor Yellow
    exit 1
  }
  Write-Host 'SSH OK.'
}
