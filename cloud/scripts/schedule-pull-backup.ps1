<#
 Đặt lịch Windows (Task Scheduler) chạy pull-backup.ps1 mỗi tuần để có bản sao lưu NGOÀI VPS.
   .\cloud\scripts\schedule-pull-backup.ps1                    # Chủ nhật 21:00
   .\cloud\scripts\schedule-pull-backup.ps1 -Day Monday -At 08:30
   .\cloud\scripts\schedule-pull-backup.ps1 -Remove            # gỡ lịch
 Máy phải bật và có SSH (ssh plciot-vps) không hỏi mật khẩu; lỡ giờ thì chạy bù khi bật máy (StartWhenAvailable).
#>
param([string]$Day = 'Sunday', [string]$At = '21:00', [switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'plciot-pull-backup'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; 'Đã gỡ lịch.'; return }
$script = Join-Path $PSScriptRoot 'pull-backup.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Kéo bản sao lưu DB plciot từ VPS về máy này' -Force | Out-Null
"Đã đặt lịch '$name': mỗi $Day lúc $At. Chạy thử ngay: Start-ScheduledTask -TaskName $name ; xem nhật ký: $env:USERPROFILE\plciot-backups\pull-backup.log"
