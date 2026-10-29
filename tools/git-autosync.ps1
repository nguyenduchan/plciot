# Tự đồng bộ code từ GitHub về PC này CHỈ KHI có commit mới do PC khác đẩy lên.
#
# Mỗi lần chạy:
#   1. git fetch origin <nhánh>.
#   2. Nếu origin/<nhánh> trùng HEAD hiện tại           -> không làm gì (không có HEAD mới).
#      Nếu máy này còn code chưa commit                 -> không làm gì (đợi commit/bỏ thay đổi rồi mới kéo).
#      Nếu máy này đang có commit chưa push (đi trước)  -> không làm gì.
#      Nếu hai bên rẽ nhánh                             -> không làm gì, chỉ ghi log.
#      Nếu origin đi trước (có commit từ PC khác)       -> git merge --ff-only (không reset --hard,
#                                                         không bao giờ ghi đè thay đổi chưa commit).
#   3. Sau khi kéo về: nếu có đổi mã máy chủ (cloud/app, packages/security, docker-compose) thì build lại
#      container app. Chỉ đổi webapp/ thì không cần: webapp được mount, điện thoại tự cập nhật sau vài giây.
#
# Chạy thử một lần:     powershell -ExecutionPolicy Bypass -File tools\git-autosync.ps1
# Cài chạy nền mỗi phút: powershell -ExecutionPolicy Bypass -File tools\install-git-autosync.ps1
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [switch]$NoRebuild
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'git-autosync.log'

function Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}
function Run-Git {
  # Không dùng 2>&1 trên lệnh native (PowerShell 5.1 coi stderr là lỗi); lấy mã thoát để xét.
  $out = & git -C $RepoDir @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') thất bại (mã $LASTEXITCODE)" }
  return $out
}

# Khoá chống chạy chồng (build có thể lâu hơn chu kỳ chạy)
$lock = Join-Path $RepoDir '.git\autosync.lock'
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 20) { exit 0 }
Set-Content -Path $lock -Value $PID
try {
  try { Run-Git fetch --quiet $Remote $Branch | Out-Null }
  catch { Log "Không fetch được (mạng/GitHub?): $($_.Exception.Message)"; exit 0 }

  $local = (Run-Git rev-parse HEAD).Trim()
  $remoteSha = (Run-Git rev-parse "$Remote/$Branch").Trim()
  if ($local -eq $remoteSha) { exit 0 } # không có HEAD mới

  & git -C $RepoDir merge-base --is-ancestor $remoteSha $local
  if ($LASTEXITCODE -eq 0) { exit 0 } # origin là tổ tiên của HEAD: máy này đi trước, chưa push

  & git -C $RepoDir merge-base --is-ancestor $local $remoteSha
  if ($LASTEXITCODE -ne 0) {
    Log "Hai bên rẽ nhánh (local $($local.Substring(0,7)) / origin $($remoteSha.Substring(0,7))). Bỏ qua, hãy tự xử lý (rebase/merge)."
    exit 0
  }

  # Máy này đang có thay đổi code chưa commit: không kéo (tránh trộn lẫn / build nhầm). Commit hoặc bỏ thay đổi thì lần chạy sau tự kéo.
  $dirty = @(Run-Git status --porcelain --untracked-files=no)
  if ($dirty.Count -gt 0) {
    $marker = Join-Path $RepoDir '.git\autosync-dirty-logged'
    if (-not (Test-Path $marker) -or (Get-Content $marker -ErrorAction SilentlyContinue) -ne $remoteSha) {
      Log "Có HEAD mới ($($remoteSha.Substring(0,7))) nhưng máy này còn $($dirty.Count) tệp chưa commit: chưa đồng bộ."
      Set-Content -Path $marker -Value $remoteSha
    }
    exit 0
  }

  $files = @(Run-Git diff --name-only $local $remoteSha)
  $subject = (Run-Git log -1 --pretty=format:'%h %s (%an)' $remoteSha).Trim()
  Log "Có HEAD mới từ máy khác: $subject ($($files.Count) tệp)"

  try { Run-Git merge --ff-only "$Remote/$Branch" | Out-Null }
  catch { Log "Không kéo được (có thay đổi chưa commit trùng tệp?): $($_.Exception.Message). Giữ nguyên thay đổi của bạn."; exit 0 }
  Log "Đã cập nhật lên $($remoteSha.Substring(0,7))."

  $serverChanged = $files | Where-Object { $_ -match '^(cloud/app/|packages/security/|cloud/docker-compose\.yml|cloud/config/)' }
  if (-not $serverChanged) {
    if ($files | Where-Object { $_ -match '^webapp/' }) { Log 'Chỉ đổi webapp: không cần build, điện thoại tự cập nhật sau vài giây.' }
    exit 0
  }
  if ($NoRebuild) { Log 'Đã đổi mã máy chủ nhưng -NoRebuild: bỏ qua build.'; exit 0 }

  Log 'Đổi mã máy chủ: build lại container app…'
  $compose = Join-Path $RepoDir 'cloud\docker-compose.yml'
  Push-Location (Join-Path $RepoDir 'cloud')
  try {
    & docker compose -f $compose up -d --build app | Out-Null
    if ($LASTEXITCODE -eq 0) { Log 'Build xong, server đã chạy bản mới.' } else { Log "Build thất bại (mã $LASTEXITCODE). Kiểm tra Docker Desktop." }
  } finally { Pop-Location }
}
catch { Log "Lỗi: $($_.Exception.Message)" }
finally { Remove-Item -Path $lock -ErrorAction SilentlyContinue }
