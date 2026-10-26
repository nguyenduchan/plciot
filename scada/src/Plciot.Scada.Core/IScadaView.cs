namespace Plciot.Scada;

/// <summary>
/// Mặt cắt mà MỌI giao diện (WPF, web, giao diện riêng của từng khách hàng) dùng để xem và điều khiển PLC.
/// Có hai bản cài đặt: <see cref="ScadaCore"/> (tại máy, điều khiển trực tiếp PLC) và RemoteMonitorClient (máy khác, chỉ giám sát).
/// Giao diện chỉ phụ thuộc interface này nên đổi nguồn mà không sửa giao diện.
/// </summary>
public interface IScadaView
{
    string Site { get; }
    string Device { get; }
    /// <summary>Trạng thái mới nhất của PLC (an toàn khi gọi từ mọi luồng).</summary>
    DeviceState.Snapshot State { get; }
    /// <summary>false = chỉ giám sát (máy giám sát từ xa, tài khoản viewer...): giao diện nên khoá nút điều khiển.</summary>
    bool CanControl { get; }
    /// <summary>Dòng trạng thái phụ (cloud, số thiết bị LAN, nguồn dữ liệu...) để giao diện hiển thị tuỳ ý.</summary>
    string InfoLine { get; }
    string[] RecentLog { get; }
    event Action<string>? Log;
    /// <summary>Ghi một thanh ghi D (chỉ các thanh ghi trong whitelist). Trả null nếu thành công, ngược lại là mã lỗi.</summary>
    Task<string?> WriteAsync(int address, int value, string actor = "ui", CancellationToken ct = default);
}
