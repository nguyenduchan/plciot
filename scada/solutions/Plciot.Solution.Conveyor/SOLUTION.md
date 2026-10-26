# Giải pháp: Conveyor (tham chiếu, giao diện WPF)

> Bộ nhớ của giải pháp cho người và LLM. Ghi yêu cầu/quyết định TRƯỚC khi sửa mã.

## Khách hàng / thiết bị
- Dây chuyền băng tải đếm sản phẩm, PLC Xinje XD3-16T-E qua Modbus TCP (`plc/xd3_logic.st`), bản đồ thanh ghi: `docs/PROTOCOL.md`.

## Quyết định chế độ (khớp `ConveyorSolution.cs`)
| Mục | Giá trị | Lý do |
|---|---|---|
| Số màn hình | MỘT màn hình trên máy chính (`UseSingleScreen`) | điều khiển trực tiếp, không client-server |
| Màn hình phụ | không | |
| Điện thoại | Off mặc định; `Enforce` không cho `Control` (tối đa MonitorOnly) | khách hàng không cho điều khiển từ điện thoại |
| Thanh ghi ghi được | D3 chế độ, D4 mặt nạ Y, D6 chạy/dừng, D7 mục tiêu, D9 xoá đếm | khớp whitelist gateway |

## Giao diện (WPF, `MainWindow`)
- Giám sát / Điều khiển / Nhật ký / Cài đặt (chỉ thông số hiện trường: site, PLC, cloud). Chế độ do giải pháp khoá, hiển thị ở đầu tab Cài đặt.
- Quyền điều khiển lấy từ `IScadaView.CanControl`; đổi quyền bằng `ConveyorSolution`, không sửa cửa sổ.

## Đăng nhập và phân quyền tại nhà máy (yêu cầu mới)
PC đặt trong nhà máy, có thể không có Internet, nên KHÔNG dùng Telegram/OTP/cloud để đăng nhập. Tất cả cục bộ, hoạt động offline.
| Quyết định | Lý do |
|---|---|
| **Mở app là xem được ngay (chế độ chỉ xem), không chặn bằng màn hình đăng nhập.** Chỉ điều khiển / cài đặt / quản lý người dùng mới đòi đăng nhập | màn hình treo tường phải luôn hiển thị; không ai phải đăng nhập để biết máy đang chạy hay lỗi |
| Tài khoản lưu ở `users.json` cạnh `config.json`, mật khẩu băm PBKDF2-SHA256 (210.000 vòng, muối riêng), không lưu mật khẩu thô | lộ file cũng không đọc được mật khẩu |
| Chưa có tài khoản: lần đầu mở app bắt TẠO quản trị viên (không có mật khẩu mặc định) | mật khẩu mặc định kiểu admin/admin là lỗ hổng phổ biến nhất ở nhà máy |
| 4 vai trò cộng dồn: Viewer (xem) < Operator (+ chạy/dừng, chế độ, đầu ra, mục tiêu, xoá đếm) < Engineer (+ cài đặt PLC/cloud) < Admin (+ quản lý người dùng, xem nhật ký kiểm toán) | tách người vận hành khỏi người chỉnh cấu hình |
| Sai mật khẩu 5 lần → khoá tài khoản đó 60 giây (tăng gấp đôi mỗi lần tái phạm, tối đa 15 phút) | chống dò mật khẩu mà không khoá hẳn khi cần xử lý sự cố |
| Tự đăng xuất về chế độ chỉ xem sau 10 phút không thao tác | ca sau không dùng nhầm phiên của ca trước |
| Nhật ký kiểm toán `audit-YYYYMM.log`: đăng nhập, đăng nhập sai, đăng xuất, mọi lệnh điều khiển, đổi cài đặt, quản lý người dùng — ghi kèm tên người | truy vết "ai đã dừng băng tải lúc mấy giờ"; tên người cũng đi vào `actor` của `WriteAsync` nên nằm trong nhật ký lõi |
| Không thể xoá / hạ quyền / khoá quản trị viên cuối cùng | tránh tự khoá mình |
| Quên mật khẩu admin: không có đường vòng qua mạng; người có quyền Windows trên máy xoá `users.json` để tạo lại | chỉ người có quyền vật lý + quản trị Windows mới khôi phục được |
| Quyền theo vai trò chỉ THU HẸP quyền: nút điều khiển bật khi `IScadaView.CanControl` (chính sách framework) VÀ vai trò ≥ Operator | không tự nới quyền ngoài chính sách của giải pháp |

## Giao diện (WPF)
Theo phong cách Grafana tối: thanh bên trái, thanh trên có trạng thái PLC + người dùng, các "panel" có tiêu đề, ô số liệu (stat) tô màu theo ngưỡng, đồ thị tốc độ và số đếm theo thời gian, hàng LED cho X/Y. Chủ đề ở `Theme.xaml`.

## Chưa kiểm chứng
- Cửa sổ WPF khi chạy thật (mới build); PLC thật.

## Lịch sử thay đổi
- Tách từ ứng dụng WPF cũ (`Plciot.Scada.App`) thành giải pháp riêng trên framework.
- Thêm đăng nhập cục bộ 4 vai trò, khoá tạm, tự đăng xuất, nhật ký kiểm toán; đổi giao diện sang phong cách Grafana.
