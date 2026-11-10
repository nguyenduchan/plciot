namespace GatewayApp;

static class Program
{
    /// <summary>
    ///   GatewayApp.exe                 mở giao diện
    ///   GatewayApp.exe --demo          PLC giả trong chương trình (bồn nước + bơm), tự chạy, không cần mạng
    ///   GatewayApp.exe --autostart     tự chạy gateway với cấu hình đã lưu
    ///   GatewayApp.exe --demo --shot D chụp ảnh các trang vào thư mục D rồi thoát (kiểm tra giao diện)
    /// </summary>
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var form = new MainForm();
        if (args.Contains("--autodemo")) form.Shown += async (_, _) => await form.AutoDemoAsync();
        var i = Array.IndexOf(args, "--shot");
        if (i >= 0 && i + 1 < args.Length) form.Shown += async (_, _) => await form.ScreenshotsAsync(args[i + 1]);
        var j = Array.IndexOf(args, "--selftest");
        if (j >= 0 && j + 1 < args.Length) form.Shown += async (_, _) => await form.SelfTestAsync(args[j + 1]);
        var k = Array.IndexOf(args, "--pairtest");
        if (k >= 0 && k + 1 < args.Length) form.Shown += async (_, _) => await form.PairTestAsync(args[k + 1]);
        Application.Run(form);
    }
}
