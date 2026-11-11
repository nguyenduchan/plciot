namespace GatewayAdmin;

static class Program
{
    /// <summary>
    ///   GatewayAdmin.exe                       mở tool, nhập địa chỉ + token rồi Kết nối
    ///   GatewayAdmin.exe --connect 127.0.0.1:8750 --token MÃ   tự kết nối (token mặc định đọc từ file của gateway cùng máy)
    ///   GatewayAdmin.exe --connect ... --shot F.png tự chụp cửa sổ ra file rồi thoát (kiểm tra giao diện)
    /// </summary>
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var f = new AdminForm();
        var t = Array.IndexOf(args, "--token");
        if (t >= 0 && t + 1 < args.Length) f.Token = args[t + 1];
        var i = Array.IndexOf(args, "--connect");
        if (i >= 0 && i + 1 < args.Length) f.Shown += async (_, _) => await f.ConnectAsync(args[i + 1]);
        var j = Array.IndexOf(args, "--shot");
        if (j >= 0 && j + 1 < args.Length) f.Shown += async (_, _) => await f.ShotAsync(args[j + 1]);
        Application.Run(f);
    }
}
