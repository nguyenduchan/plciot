# Cài tác vụ nền (Task Scheduler) chạy tools\git-autosync.ps1 mỗi phút, tự bật khi đăng nhập Windows.
#   Cài:   powershell -ExecutionPolicy Bypass -File tools\install-git-autosync.ps1
#   Gỡ:    powershell -ExecutionPolicy Bypass -File tools\install-git-autosync.ps1 -Remove
param([int]$EveryMinutes = 1, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'PLCIoT-GitAutoSync'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Đã gỡ tác vụ $name."
  exit 0
}
$script = Join-Path $PSScriptRoot 'git-autosync.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Kéo code mới từ GitHub khi có commit từ PC khác' -Force | Out-Null
Write-Host "Đã cài tác vụ $name, chạy mỗi $EveryMinutes phút. Log: tools\git-autosync.log"
