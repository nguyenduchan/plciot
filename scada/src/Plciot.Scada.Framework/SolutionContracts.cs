namespace Plciot.Scada;

/// <summary>
/// GIẢI PHÁP của một khách hàng/nhà máy: gom MỌI thứ riêng của họ vào một dự án (scada/solutions/&lt;Ten&gt;).
/// Framework lo phần cố định (nối PLC, một/nhiều màn hình, quyền điều khiển, điện thoại, cloud, server, vòng đời);
/// giải pháp chỉ khai báo: chọn chế độ, thanh ghi ghi được, logic riêng (module) và giao diện riêng.
/// </summary>
public interface IScadaSolution
{
    /// <summary>Tên hiển thị (ví dụ "Nhà máy ABC – băng tải").</summary>
    string Name { get; }

    /// <summary>
    /// Cấu hình mặc định khi chưa có file cấu hình (lần chạy đầu). Dùng các hàm trong <see cref="ScadaConfigExtensions"/>
    /// (UseSingleScreen / UseMultiScreen / UseMobile…) để chọn chế độ một cách dễ đọc.
    /// </summary>
    ScadaConfig CreateDefaultConfig();

    /// <summary>
    /// Luôn được gọi SAU khi nạp file cấu hình: nơi khoá những quyết định mà nhà máy KHÔNG được đổi bằng file
    /// (ví dụ ép topology, ép "điện thoại chỉ xem", danh sách thanh ghi ghi được). Thông số hiện trường (IP, mật khẩu) giữ nguyên từ file.
    /// </summary>
    void Enforce(ScadaConfig cfg);

    /// <summary>Logic riêng của khách hàng chạy cùng ứng dụng (cảnh báo, tag dẫn xuất, thông báo...). Chỉ chạy ở máy chính.</summary>
    IEnumerable<IScadaModule> CreateModules();

    /// <summary>Giao diện riêng của khách hàng; null = chạy nền không giao diện.</summary>
    IScadaUi? CreateUi();
}

/// <summary>Logic riêng của khách hàng. Chỉ dùng <see cref="SolutionContext"/> (lõi/IScadaView), không sửa framework.</summary>
public interface IScadaModule
{
    string Name { get; }
    Task StartAsync(SolutionContext ctx, CancellationToken ct);
    Task StopAsync();
}

/// <summary>Giao diện riêng của khách hàng (WPF, WinForms, web, kiosk…). Chỉ làm việc với <see cref="IScadaView"/>.</summary>
public interface IScadaUi
{
    /// <summary>Chạy giao diện; trả về khi người dùng đóng ứng dụng.</summary>
    Task RunAsync(SolutionContext ctx, CancellationToken ct);
}

/// <summary>Mọi thứ giải pháp được phép dùng.</summary>
public sealed class SolutionContext
{
    public required IScadaSolution Solution { get; init; }
    public required ScadaConfig Config { get; init; }
    public required string ConfigPath { get; init; }
    /// <summary>Mặt cắt giao diện: ở máy chính là lõi (điều khiển trực tiếp), ở máy màn hình phụ là client tới máy chính.</summary>
    public required IScadaView View { get; init; }
    /// <summary>Chỉ có ở máy chính (Station = Main); null ở máy màn hình phụ.</summary>
    public ScadaCore? Core { get; init; }
    public ScadaHost? Host { get; init; }
    public bool IsMainStation => Core != null;
    /// <summary>Yêu cầu chạy lại ứng dụng (sau khi lưu cấu hình).</summary>
    public Action RequestRestart { get; init; } = () => { };
}
