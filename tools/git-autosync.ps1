# Tự đồng bộ code từ GitHub về PC này và đảm bảo Docker luôn chạy bản mới nhất.
#
# PHẦN 1 - Git (chỉ khi máy này KHÔNG sửa code và có HEAD mới từ máy khác, kể cả amend/force-push):
#   - origin trùng HEAD / máy này đi trước                -> không làm gì.
#   - máy này còn file chưa commit hoặc có commit riêng   -> không làm gì (giữ nguyên code của bạn), ghi log một lần.
#   - còn lại                                             -> git rebase --fork-point origin/<nhánh> (bỏ commit cũ đã bị amend,
#                                                           đặt máy này đúng bản mới nhất). Xung đột thì tự huỷ rebase.
#
# PHẦN 2 - Docker (chạy MỖI lần, kể cả khi không có HEAD mới):
#   - Docker chưa chạy        -> mở Docker Desktop và chờ engine sẵn sàng.
#   - container chưa lên      -> docker compose up -d (cả stack trong cloud/docker-compose.yml).
#   - code máy chủ đã đổi so với lần build gần nhất (cloud/app, packages/security, compose, Dockerfile)
#                             -> docker compose up -d --build app. Chỉ đổi webapp/ thì không cần (webapp được mount).
#   - Cloudflare: kiểm tra server cục bộ và địa chỉ công khai (WEBAPP_PUBLIC_URL trong cloud/.env) mỗi lần chạy. Cục bộ ổn
#     mà công khai hỏng 2 lần liên tiếp -> restart tunnel; app cục bộ không trả lời 2 lần liên tiếp -> restart app.
#     Mã webapp công khai khác bản trên đĩa cũng được ghi log (cache Cloudflare).
#   Nhớ commit đã build trong .git/autosync-built nên nếu lúc kéo code Docker đang tắt thì lần sau bật lên vẫn tự build.
#
# Chạy thử một lần:     powershell -ExecutionPolicy Bypass -File tools\git-autosync.ps1
# Cài chạy nền mỗi phút: powershell -ExecutionPolicy Bypass -File tools\install-git-autosync.ps1
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [switch]$NoRebuild,   # không build container (chỉ để thử)
  [switch]$NoDocker,    # bỏ qua toàn bộ phần Docker (chỉ để thử)
  [int]$DockerWaitSec = 240
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'git-autosync.log'
$marker = Join-Path $RepoDir '.git/autosync-logged'
$builtFile = Join-Path $RepoDir '.git/autosync-built'
$serverPattern = '^(cloud/app/|packages/security/|cloud/docker-compose\.yml|cloud/config/)'

function Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}
function Log-Once([string]$key, [string]$msg) {
  # Cùng một trạng thái mà lần nào chạy cũng báo thì log phình ra: chỉ ghi khi đổi trạng thái.
  if ((Test-Path $marker) -and ((Get-Content $marker -ErrorAction SilentlyContinue) -eq $key)) { return }
  Log $msg
  Set-Content -Path $marker -Value $key
}
function Run-Git {
  # Không dùng 2>&1 trên lệnh native (PowerShell 5.1 coi stderr là lỗi); lấy mã thoát để xét.
  $out = & git -C $RepoDir @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') thất bại (mã $LASTEXITCODE)" }
  return $out
}
# Chạy lệnh native cho phép in ra stderr (git/docker in tiến trình ra stderr; PowerShell 5.1 coi đó là lỗi dừng script).
function Native([scriptblock]$cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $cmd 2>$null; return @{ Rc = $LASTEXITCODE; Out = $out } }
  finally { $ErrorActionPreference = $prev }
}

# ---------------------------------------------------------------- PHẦN 1: Git
function Sync-Git {
  $r = Native { git -C $RepoDir fetch --quiet $Remote $Branch }
  if ($r.Rc -ne 0) { Log-Once 'fetch-fail' 'Không fetch được (mạng/GitHub?). Thử lại ở lần chạy sau.'; return }
  if ((Test-Path $marker) -and ((Get-Content $marker) -eq 'fetch-fail')) { Remove-Item $marker -ErrorAction SilentlyContinue }

  $local = (Run-Git rev-parse HEAD).Trim()
  $remoteSha = (Run-Git rev-parse "$Remote/$Branch").Trim()
  if ($local -eq $remoteSha) { return } # không có HEAD mới

  & git -C $RepoDir merge-base --is-ancestor $remoteSha $local
  if ($LASTEXITCODE -eq 0) { return } # origin là tổ tiên của HEAD: máy này đi trước, chưa push

  # Từ đây origin có thứ máy này chưa có: hoặc đi trước (commit mới), hoặc lịch sử bị viết lại (amend / force-push).
  & git -C $RepoDir merge-base --is-ancestor $local $remoteSha
  $rewritten = ($LASTEXITCODE -ne 0)

  # Máy này đang sửa code chưa commit: không kéo. Commit hoặc bỏ thay đổi thì lần chạy sau tự kéo.
  $dirty = @(Run-Git status --porcelain --untracked-files=no)
  if ($dirty.Count -gt 0) {
    Log-Once "dirty-$remoteSha" "Có HEAD mới ($($remoteSha.Substring(0,7))) nhưng máy này còn $($dirty.Count) tệp chưa commit: chưa đồng bộ."
    return
  }

  # Commit RIÊNG chưa push (không thuộc lịch sử cũ của origin) nghĩa là đang sửa code ở máy này: không tự đồng bộ.
  if ($rewritten) {
    $f = Native { git -C $RepoDir merge-base --fork-point "$Remote/$Branch" HEAD }
    $fork = ($f.Out | Select-Object -First 1)
    if ($f.Rc -ne 0 -or -not $fork) {
      Log-Once "nofork-$remoteSha" 'Origin có HEAD mới (máy khác commit/amend) nhưng không xác định được commit riêng của máy này: chưa đồng bộ (hãy tự rebase).'
      return
    }
    $own = [int](Run-Git rev-list --count "$($fork.Trim())..$local")
    if ($own -gt 0) {
      Log-Once "own-$remoteSha" "Origin có HEAD mới (máy khác commit/amend) nhưng máy này có $own commit riêng chưa push: chưa đồng bộ (giữ nguyên code của bạn)."
      return
    }
  }

  $subject = (Run-Git log -1 --pretty=format:'%h %s (%an)' $remoteSha).Trim()
  $why = $(if ($rewritten) { 'máy khác đã amend/force-push' } else { 'có HEAD mới từ máy khác' })

  # rebase --fork-point dùng reflog của origin/<nhánh> để nhận ra commit cũ đã bị amend và bỏ chúng.
  $rb = Native { git -C $RepoDir rebase --fork-point "$Remote/$Branch" }
  if ($rb.Rc -ne 0) {
    $null = Native { git -C $RepoDir rebase --abort } # không bao giờ để lại rebase dở dang
    Log-Once "conflict-$remoteSha" "(${why}: ${subject}) Rebase lên $($remoteSha.Substring(0,7)) bị xung đột; đã huỷ (rebase --abort), giữ nguyên code của bạn. Hãy tự chạy: git rebase $Remote/$Branch"
    return
  }
  $now = (Run-Git rev-parse HEAD).Trim()
  $files = @(Run-Git diff --name-only $local $now)
  Log "Đã cập nhật lên $($now.Substring(0,7)) (${why}: ${subject}; $($files.Count) tệp đổi)."
  if (-not ($files | Where-Object { $_ -match $serverPattern }) -and ($files | Where-Object { $_ -match '^webapp/' })) {
    Log 'Chỉ đổi webapp: không cần build, điện thoại tự cập nhật sau vài giây.'
  }
}

# ---------------------------------------------------------------- PHẦN 2: Docker
function Docker-Ready { (Native { docker info --format '{{.ServerVersion}}' }).Rc -eq 0 }

function Ensure-Docker {
  if (Docker-Ready) { return $true }
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path $exe)) { Log-Once 'no-docker' 'Docker chưa chạy và không tìm thấy Docker Desktop để bật.'; return $false }
  if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    Log 'Docker chưa chạy: đang mở Docker Desktop…'
    Start-Process -FilePath $exe | Out-Null
  }
  $deadline = (Get-Date).AddSeconds($DockerWaitSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Docker-Ready) { Log 'Docker đã sẵn sàng.'; return $true }
  }
  Log-Once 'docker-timeout' "Chờ $DockerWaitSec giây mà Docker chưa sẵn sàng. Sẽ thử lại ở lần chạy sau."
  return $false
}

function Sync-Docker {
  if (-not (Ensure-Docker)) { return }
  if ((Test-Path $marker) -and ((Get-Content $marker) -in @('no-docker', 'docker-timeout'))) { Remove-Item $marker -ErrorAction SilentlyContinue }
  $compose = Join-Path $RepoDir 'cloud/docker-compose.yml'
  $cloudDir = Join-Path $RepoDir 'cloud'
  if (-not (Test-Path $compose)) { return }

  # 1) Container chưa lên -> bật cả stack (không build)
  $want = @((Native { docker compose -f $compose config --services }).Out | Where-Object { $_ })
  $running = @((Native { docker compose -f $compose ps --status running --services }).Out | Where-Object { $_ })
  $missing = @($want | Where-Object { $_ -notin $running })
  if ($missing.Count -gt 0) {
    Log "Container chưa chạy: $($missing -join ', '). Đang docker compose up -d…"
    Push-Location $cloudDir
    try { $up = Native { docker compose -f $compose up -d } } finally { Pop-Location }
    if ($up.Rc -eq 0) { Log 'Đã bật các container.' } else { Log-Once 'up-fail' "docker compose up -d thất bại (mã $($up.Rc)). Kiểm tra cloud/.env và Docker Desktop." }
  }

  # 2) Code máy chủ đã đổi so với lần build gần nhất -> build lại app
  $head = (Run-Git rev-parse HEAD).Trim()
  $built = if (Test-Path $builtFile) { (Get-Content $builtFile -ErrorAction SilentlyContinue | Select-Object -First 1) } else { $null }
  if (-not $built) { Set-Content -Path $builtFile -Value $head; return } # lần đầu: coi như container đang chạy đúng bản hiện tại
  if ($built -eq $head) { return }
  $d = Native { git -C $RepoDir diff --name-only $built $head }
  $needBuild = ($d.Rc -ne 0) -or [bool](@($d.Out) | Where-Object { $_ -match $serverPattern }) # không so sánh được (commit cũ bị amend) -> build cho chắc
  if (-not $needBuild) { Set-Content -Path $builtFile -Value $head; return }
  if ($NoRebuild) { Log-Once "norebuild-$head" 'Code máy chủ đã đổi nhưng -NoRebuild: bỏ qua build.'; return }
  Log "Code máy chủ đã đổi ($($built.Substring(0,7)) -> $($head.Substring(0,7))): build lại container app…"
  Push-Location $cloudDir
  try { $bd = Native { docker compose -f $compose up -d --build app } } finally { Pop-Location }
  if ($bd.Rc -eq 0) {
    Set-Content -Path $builtFile -Value $head
    Log 'Build xong, server đã chạy bản mới.'
  } else {
    Log-Once "build-fail-$head" "Build thất bại (mã $($bd.Rc)). Sẽ thử lại ở lần chạy sau."
  }
}

# ---------------------------------------------------------------- PHẦN 3: luôn online qua Cloudflare, đúng code mới nhất
function Test-Http([string]$url) {
  try { return ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200) } catch { return $false }
}
function Public-Url {
  $envFile = Join-Path $RepoDir 'cloud/.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*WEBAPP_PUBLIC_URL\s*=' } | Select-Object -First 1
    if ($line) { $v = (($line -split '=', 2)[1]).Trim().Trim('"').TrimEnd('/'); if ($v) { return $v } }
  }
  return 'https://plc.dieukhientudong.net'
}
function Bump-Fail([string]$name, [bool]$failed) {
  $f = Join-Path $RepoDir ".git/autosync-fail-$name"
  if (-not $failed) { Remove-Item $f -ErrorAction SilentlyContinue; return 0 }
  $n = 1 + $(if (Test-Path $f) { [int](Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1) } else { 0 })
  Set-Content -Path $f -Value $n
  return $n
}

function Check-Online {
  if (-not (Docker-Ready)) { return }
  $compose = Join-Path $RepoDir 'cloud/docker-compose.yml'
  $cloudDir = Join-Path $RepoDir 'cloud'
  if (-not (Test-Path $compose)) { return }

  # App cục bộ phải trả lời; hỏng 2 lần liên tiếp thì restart app
  $localOk = Test-Http 'http://127.0.0.1:3080/api/health'
  $n = Bump-Fail 'local' (-not $localOk)
  if ($n -ge 2) {
    Log 'App cục bộ không trả lời /api/health 2 lần liên tiếp: restart app…'
    Push-Location $cloudDir
    try { $rs = Native { docker compose -f $compose restart app } } finally { Pop-Location }
    Log $(if ($rs.Rc -eq 0) { 'Đã restart app.' } else { "Restart app thất bại (mã $($rs.Rc))." })
    $null = Bump-Fail 'local' $false
    return
  }
  if (-not $localOk) { return }

  # Địa chỉ công khai (Cloudflare) phải trả lời; cục bộ ổn mà công khai hỏng 2 lần liên tiếp thì restart tunnel
  $pub = Public-Url
  $pubOk = Test-Http "$pub/api/health"
  $n = Bump-Fail 'public' (-not $pubOk)
  if ($n -ge 2) {
    Log "Địa chỉ công khai $pub không truy cập được dù server cục bộ ổn: restart tunnel Cloudflare…"
    Push-Location $cloudDir
    try { $rs = Native { docker compose -f $compose restart tunnel } } finally { Pop-Location }
    Log $(if ($rs.Rc -eq 0) { 'Đã restart tunnel. Nếu vẫn lỗi hãy kiểm tra mạng và cấu hình Cloudflare.' } else { "Restart tunnel thất bại (mã $($rs.Rc))." })
    $null = Bump-Fail 'public' $false
    return
  }
  if (-not $pubOk) { return }

  # Mã webapp công khai phải đúng bản trên đĩa (phát hiện cache Cloudflare / bundle cũ)
  try {
    $localFile = Join-Path $RepoDir 'webapp/security/login.js'
    if (Test-Path $localFile) {
      $want = (Get-FileHash $localFile -Algorithm SHA256).Hash
      $tmp = Join-Path $env:TEMP 'autosync-login.js'
      Invoke-WebRequest -Uri "$pub/security/login.js" -UseBasicParsing -TimeoutSec 10 -OutFile $tmp
      $got = (Get-FileHash $tmp -Algorithm SHA256).Hash
      Remove-Item $tmp -ErrorAction SilentlyContinue
      if ($want -ne $got) { Log-Once "stale-$got" 'Mã webapp trên địa chỉ công khai khác bản trên đĩa (có thể cache Cloudflare hoặc bundle chưa đồng bộ).' }
      elseif ((Test-Path $marker) -and ((Get-Content $marker) -like 'stale-*')) { Remove-Item $marker -ErrorAction SilentlyContinue }
    }
  } catch { }
}

# Khoá chống chạy chồng (build / chờ Docker có thể lâu hơn chu kỳ chạy)
$lock = Join-Path $RepoDir '.git/autosync.lock'
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 20) { exit 0 }
Set-Content -Path $lock -Value $PID
try {
  Sync-Git
  if (-not $NoDocker) { Sync-Docker; Check-Online }
}
catch { Log "Lỗi: $($_.Exception.Message)" }
finally { Remove-Item -Path $lock -ErrorAction SilentlyContinue }
