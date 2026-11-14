<#
 Đổi địa chỉ MQTT công khai cấp cho gateway từ IP thô sang TÊN MIỀN (để sau này đổi VPS chỉ cần đổi DNS, không phải cấu hình lại gateway).

 Trước khi chạy: tạo bản ghi DNS KHÔNG QUA PROXY Cloudflare (mây xám, "DNS only"), ví dụ
   mqtts.dieukhientudong.net  A  14.225.224.218
 (bản ghi qua proxy chỉ chạy được HTTP/WebSocket, không chạy được MQTTS cổng 48263).

 Mặc định chỉ KIỂM TRA, không đổi gì:
   .\cloud\scripts\set-mqtt-host.ps1 -NewHost mqtts.dieukhientudong.net
 Đạt hết các kiểm tra thì áp dụng:
   .\cloud\scripts\set-mqtt-host.ps1 -NewHost mqtts.dieukhientudong.net -Apply

 Lưu ý: gateway đã enroll bằng IP vẫn chạy bình thường nhưng vẫn nhớ IP cũ; chỉ gateway enroll SAU khi đổi mới nhận tên miền.
 Chứng chỉ TLS tự ký được ghim bằng hash nên tên miền không cần khớp chứng chỉ.
#>
param(
  [Parameter(Mandatory = $true)][string]$NewHost,
  [string]$ExpectedIp = '14.225.224.218',
  [int]$Port = 48263,
  [string]$Vps = 'plciot-vps',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$bad = @()

# 1) DNS phải trỏ đúng về IP VPS (không phải IP Cloudflare)
try { $ips = @(Resolve-DnsName $NewHost -Type A -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress }) } catch { $ips = @() }
if (-not $ips.Count) { $bad += "DNS: $NewHost chưa phân giải được (chưa tạo bản ghi A, hoặc DNS chưa lan)." }
elseif ($ips -notcontains $ExpectedIp) { $bad += "DNS: $NewHost trỏ tới $($ips -join ', '), không phải $ExpectedIp (đang bật proxy Cloudflare? phải để DNS only)." }
else { "OK  DNS: $NewHost -> $($ips -join ', ')" }

# 2) Cổng MQTTS mở từ bên ngoài qua tên miền
$tcp = New-Object Net.Sockets.TcpClient
try { $iar = $tcp.BeginConnect($NewHost, $Port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(5000) -and $tcp.Connected) { "OK  TCP $NewHost`:$Port mở" } else { $bad += "TCP: không kết nối được $NewHost`:$Port (tường lửa/DNS?)." } } catch { $bad += "TCP: $($_.Exception.Message)" } finally { $tcp.Close() }

# 3) TLS: chứng chỉ phục vụ qua tên miền có hash trùng hash đang ghim
$pin = (ssh $Vps "grep -E '^MQTT_PUBLIC_PIN_SHA256=' /root/plciot/cloud/.env | cut -d= -f2").Trim().ToLower() -replace '[:\s]', ''
if ($pin) {
  try {
    $c = New-Object Net.Sockets.TcpClient($NewHost, $Port)
    $ssl = New-Object Net.Security.SslStream($c.GetStream(), $false, ({ $true }))
    $ssl.AuthenticateAsClient($NewHost)
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)) -replace '-', '').ToLower()
    $c.Close()
    if ($hash -eq $pin) { 'OK  TLS: hash chứng chỉ khớp MQTT_PUBLIC_PIN_SHA256' } else { $bad += "TLS: hash chứng chỉ ($hash) khác hash đang ghim ($pin)." }
  } catch { $bad += "TLS: $($_.Exception.Message)" }
} else { 'BỎ QUA kiểm tra hash (không có MQTT_PUBLIC_PIN_SHA256: dùng chứng chỉ CA thật).' }

if ($bad.Count) { $bad | ForEach-Object { "LỖI $_" }; throw 'Chưa đạt kiểm tra, không đổi gì.' }
if (-not $Apply) { "Đạt hết kiểm tra. Chạy lại với -Apply để đổi MQTT_PUBLIC_HOST sang $NewHost."; return }

$stamp = Get-Date -Format yyyyMMddHHmmss
ssh $Vps "set -e; cd /root/plciot/cloud; cp .env .env.bak-$stamp; sed -i 's/^MQTT_PUBLIC_HOST=.*/MQTT_PUBLIC_HOST=$NewHost/' .env; grep -E '^MQTT_PUBLIC_HOST=' .env; docker compose up -d app"
"Đã đổi. Bản sao .env cũ: /root/plciot/cloud/.env.bak-$stamp. Kit/QR mới từ giờ dùng $NewHost."
