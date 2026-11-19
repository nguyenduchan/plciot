#Requires -Version 5.1
<#
.SYNOPSIS
  Build firmware gateway Waveshare. MẶC ĐỊNH: image thật cho board ESP32-S3 (pio run). -Sim: bản giả lập trên PC.
.DESCRIPTION
  .\build.ps1                 image thật nạp xuống board (.pio\build\...\firmware.bin) — KHÔNG có mã giả lập
  .\build.ps1 -Upload         build + nạp qua USB-C
  .\build.ps1 -Sim            bản giả lập trên PC: build-sim\gw-sim.exe (cờ GW_SIM, thư mục sim/)
  Bản giả lập biên dịch CHÍNH mã src/ (kể cả cloud.cpp, crypto.cpp, PubSubClient, mbedtls) — chỉ lớp phần cứng/socket/TLS trong sim/ là giả.
  Image thật không bao giờ biên dịch sim/ và báo lỗi nếu lỡ có cờ GW_SIM.
.EXAMPLE
  .\build.ps1 -Sim; $env:SIM_API_PORT=8760; .\build-sim\gw-sim.exe
#>
param(
  [switch] $Sim,        # bản giả lập trên PC (mặc định: image thật cho board)
  [switch] $Upload,     # image thật: nạp xuống board sau khi build
  [string] $Pio = '',   # đường dẫn pio.exe (mặc định: pio trong PATH)
  [string] $Gxx = ''    # đường dẫn g++ cho bản giả lập (mặc định: g++ trong PATH hoặc C:\MinGW\bin)
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Find-Lib([string] $name) {
  Get-ChildItem (Join-Path $root '.pio\libdeps') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "$name\src" } | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $Sim) {
  # ------------------------------------------------------------ image thật cho board
  if (-not $Pio) { $c = Get-Command pio -ErrorAction SilentlyContinue; if ($c) { $Pio = $c.Source } else { throw 'Không thấy pio (PlatformIO). Cài: python -m pip install platformio, hoặc truyền -Pio <đường dẫn pio.exe>.' } }
  # gói Arduino-ESP32 có đường dẫn rất sâu: thư mục PlatformIO dài sẽ vượt giới hạn 260 ký tự của Windows
  if (-not $env:PLATFORMIO_CORE_DIR -and (Test-Path 'D:\pio')) { $env:PLATFORMIO_CORE_DIR = 'D:\pio' }
  if (-not $env:PLATFORMIO_CORE_DIR) { Write-Warning 'Nếu lỗi "No such file or directory" lúc giải nén: đặt $env:PLATFORMIO_CORE_DIR = "D:\pio" (đường dẫn ngắn) hoặc bật Long Paths.' }
  Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue   # bộ cài pioarduino từ chối môi trường MSYS/Git Bash
  Write-Host '==> image thật cho board (pio run)'
  Push-Location $root
  try {
    if ($Upload) { & $Pio run -t upload } else { & $Pio run }
    if ($LASTEXITCODE -ne 0) { throw "pio lỗi ($LASTEXITCODE)" }
  } finally { Pop-Location }
  return
}

# ------------------------------------------------------------ bản giả lập trên PC (-DGW_SIM)
if ($Upload) { throw '-Upload chỉ dùng cho image thật (bỏ -Sim).' }
if (-not $Gxx) {
  $c = Get-Command g++ -ErrorAction SilentlyContinue
  $Gxx = if ($c) { $c.Source } elseif (Test-Path 'C:\MinGW\bin\g++.exe') { 'C:\MinGW\bin\g++.exe' } else { throw 'Không thấy g++ (MinGW). Truyền -Gxx <đường dẫn>.' }
}
$Gcc = Join-Path (Split-Path $Gxx) 'gcc.exe'
$aj = Find-Lib 'ArduinoJson'; $ps = Find-Lib 'PubSubClient'
if (-not $aj -or -not $ps) { throw 'Chưa có thư viện ArduinoJson/PubSubClient — chạy ".\build.ps1" (image thật) một lần hoặc "pio pkg install" để tải.' }
$mb = Join-Path $root 'sim\third_party\mbedtls'
if (-not (Test-Path "$mb\library")) { throw 'Chưa có mã nguồn mbedtls: giải nén mbedtls 3.6.x (github.com/Mbed-TLS/mbedtls/releases) vào sim\third_party\mbedtls.' }
$out = Join-Path $root 'build-sim'; $obj = Join-Path $out 'obj'; $mbo = Join-Path $out 'mbedtls'
New-Item -ItemType Directory -Force $obj, $mbo | Out-Null
$common = @('-O1', '-DGW_SIM', '-D_WIN32_WINNT=0x0601', '-DMBEDTLS_USER_CONFIG_FILE=<sim_mbedtls_config.h>', "-I$root\sim\include", "-I$mb\include")

# mbedtls: biên dịch một lần (giữ .o), chỉ làm lại khi chưa có
$mbSrc = Get-ChildItem "$mb\library\*.c"
$todo = $mbSrc | Where-Object { -not (Test-Path (Join-Path $mbo ($_.BaseName + '.o'))) }
if ($todo) { Write-Host "==> mbedtls: $($todo.Count) file" }
foreach ($f in $todo) {
  & $Gcc -std=gnu99 @common "-I$mb\library" -c $f.FullName -o (Join-Path $mbo ($f.BaseName + '.o'))
  if ($LASTEXITCODE -ne 0) { throw "mbedtls lỗi: $($f.Name)" }
}

$cxx = @('-std=gnu++14', '-g', '-DARDUINO=10800', '-D__USE_MINGW_ANSI_STDIO=1', '-DARDUINOJSON_ENABLE_ARDUINO_STRING=1', '-DARDUINOJSON_ENABLE_ARDUINO_STREAM=1',
  '-DARDUINOJSON_ENABLE_ARDUINO_PRINT=1', '-DARDUINOJSON_ENABLE_PROGMEM=0', "-I$aj", "-I$ps")
$units = @(Get-ChildItem "$root\src\*.cpp") + @(Get-ChildItem "$root\sim\*.cpp") + @(Get-Item "$ps\PubSubClient.cpp")
Write-Host "==> bản giả lập (-DGW_SIM): $($units.Count) file C++ + sim\win_compat.c"
foreach ($f in $units) {
  & $Gxx @common @cxx -c $f.FullName -o (Join-Path $obj ($f.BaseName + '.o'))
  if ($LASTEXITCODE -ne 0) { throw "Biên dịch lỗi: $($f.Name)" }
}
& $Gcc -std=gnu99 @common -c "$root\sim\win_compat.c" -o (Join-Path $obj 'win_compat.o')
if ($LASTEXITCODE -ne 0) { throw 'Biên dịch lỗi: win_compat.c' }
& $Gxx (Get-ChildItem "$obj\*.o" | ForEach-Object FullName) (Get-ChildItem "$mbo\*.o" | ForEach-Object FullName) -lws2_32 -lcrypt32 -o (Join-Path $out 'gw-sim.exe')
if ($LASTEXITCODE -ne 0) { throw 'Liên kết lỗi' }
Write-Host "==> $out\gw-sim.exe  (bản GIẢ LẬP — không nạp xuống board)"
