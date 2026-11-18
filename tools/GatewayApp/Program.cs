namespace GatewayApp;

static class Program
{
    /// <summary>
    ///   GatewayApp.exe                 mở giao diện
    ///   GatewayApp.exe --autostart     tự chạy gateway với cấu hình đã lưu
    ///   GatewayApp.exe --solshot D     chụp giao diện giải pháp vào thư mục D rồi thoát (dữ liệu từ PlcSim: tools/PlcSim, plcsim-uitest.ps1)
    ///   GatewayApp.exe --noauth        TẠM THỜI: bỏ qua đăng nhập/OTP (chỉ để test)
    /// </summary>
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var sheet = Array.IndexOf(args, "--iconsheet");
        if (sheet >= 0 && sheet + 1 < args.Length) { MainForm.IconSheet(args[sheet + 1]); return; }
        var first = true;
        // Đổi giải pháp (kiểu giao diện) lúc đang chạy: dựng lại cửa sổ NGAY trong cùng tiến trình với bảng màu/trang mới
        // (không phải mở lại app). Trạng thái OTP được giữ để không bắt nhập lại.
        while (first || MainForm.RestartRequested)
        {
            if (!first) { MainForm.RestartRequested = false; GatewayApp.Ui.SkinStore.Reload(); }
            var form = new MainForm();
            if (first)
            {
                var j = Array.IndexOf(args, "--selftest");
                if (j >= 0 && j + 1 < args.Length) form.Shown += async (_, _) => await form.SelfTestAsync(args[j + 1]);
                var k = Array.IndexOf(args, "--pairtest");
                if (k >= 0 && k + 1 < args.Length) form.Shown += async (_, _) => await form.PairTestAsync(args[k + 1]);
                var fr = Array.IndexOf(args, "--freshtest");
                if (fr >= 0 && fr + 1 < args.Length) form.Shown += async (_, _) => await form.FreshTestAsync(args[fr + 1]);
                var st = Array.IndexOf(args, "--slottest");
                if (st >= 0 && st + 1 < args.Length) form.Shown += async (_, _) => await form.SlotTestAsync(args[st + 1]);
                var ss = Array.IndexOf(args, "--solshot");
                if (ss >= 0 && ss + 1 < args.Length) form.Shown += async (_, _) => await form.SolShotAsync(args[ss + 1]);
                var m = Array.IndexOf(args, "--edittest");
                if (m >= 0 && m + 1 < args.Length) form.Shown += async (_, _) => await form.EditTestAsync(args[m + 1]);
            }
            first = false;
            Application.Run(form);
        }
    }
}
