using System.Security.Cryptography;
using Plciot.Scada;

// SCADA chạy nền không giao diện, dùng DefaultSolution (không khoá quyết định nào; mọi chế độ chỉnh bằng file cấu hình).
// Giải pháp riêng của từng khách hàng nằm ở scada/solutions/*; Host này dành cho thử nhanh và dịch vụ nền đơn giản.
//   Plciot.Scada.Host init [--config đường_dẫn]    tạo cấu hình mới với mật khẩu ngẫu nhiên
//   Plciot.Scada.Host [--config đường_dẫn] [--station main|screen]   chạy
var argv = args.ToList();
var ci = argv.IndexOf("--config");
var cfgPath = ConfigStore.PathFor("default");
if (ci >= 0 && ci + 1 < argv.Count) cfgPath = argv[ci + 1];

if (argv.Count > 0 && argv[0] == "init")
{
    if (File.Exists(cfgPath)) { Console.Error.WriteLine($"Đã có {cfgPath}; xoá trước nếu muốn tạo lại."); return 1; }
    static string Pw() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(12)).Replace('+', 'A').Replace('/', 'B').TrimEnd('=');
    var cfg = new DefaultSolution().CreateDefaultConfig();
    cfg.LocalUsers = new()
    {
        new LocalUser { User = "gw", Password = Pw(), Role = LocalRole.Device },
        new LocalUser { User = "operator", Password = Pw(), Role = LocalRole.Operator },
        new LocalUser { User = "viewer", Password = Pw(), Role = LocalRole.Monitor },
    };
    ConfigStore.Save(cfgPath, cfg);
    Console.WriteLine($"Đã tạo {cfgPath}\nTài khoản nội bộ (ghi lại, chỉ hiện một lần):");
    foreach (var u in cfg.LocalUsers) Console.WriteLine($"  {u.User,-9} {u.Role,-8} {u.Password}");
    Console.WriteLine("Chế độ mặc định: MỘT màn hình, điện thoại tắt. Đổi Topology/Mobile/Control trong file cấu hình khi cần.");
    return 0;
}

if (!File.Exists(cfgPath)) { Console.Error.WriteLine("Chưa có cấu hình. Chạy: Plciot.Scada.Host init"); return 1; }
return await SolutionRunner.RunAsync(new DefaultSolution(), ci >= 0 ? args : args.Concat(new[] { "--config", cfgPath }).ToArray());
