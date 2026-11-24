namespace GatewayApp;

/// <summary>
/// Tuỳ chọn dòng lệnh. Bản PHÁT HÀNH (Release): KHÔNG có tuỳ chọn nào — chương trình chỉ mở bằng double-click, mọi tham số truyền vào đều bị bỏ qua.
/// Bản DEBUG giữ các cờ kiểm thử (--selftest, --boarddo, --lanui…) để chạy bộ test; luôn build Debug khi cần test: dotnet build -c Debug.
/// Mọi nơi trong GatewayApp đọc tham số qua đây, không gọi Environment.GetCommandLineArgs() trực tiếp.
/// </summary>
static class RunOptions
{
#if DEBUG
    public static string[] Args { get; } = Environment.GetCommandLineArgs();
#else
    public static string[] Args { get; } = Environment.GetCommandLineArgs().Take(1).ToArray();   // chỉ tên exe
#endif
}
