# Mở trang admin trên PC này qua đường hầm SSH (không cần đăng nhập, xem docs ADMIN_SSH_LOGIN).
# Dùng:  .\cloud\scripts\admin-tunnel.ps1     rồi mở http://localhost:8080/admin.html  (Ctrl+C để đóng)
param([int]$Port = 8080)
Start-Process "http://localhost:$Port/admin.html"
ssh -N -o ExitOnForwardFailure=yes -L "${Port}:127.0.0.1:3080" plciot-vps
