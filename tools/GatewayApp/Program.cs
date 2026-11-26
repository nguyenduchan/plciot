namespace GatewayApp;

static class Program
{
    /// <summary>
    /// GatewayApp.exe KHÔNG có tuỳ chọn dòng lệnh: chỉ mở bằng double-click (Release bỏ qua mọi tham số).
    /// Cờ kiểm thử (--selftest, --boarddo, --lanui, --wifisetup…) chỉ có ở bản Debug — xem <see cref="RunOptions"/>.
    /// </summary>
    [STAThread]
    static void Main(string[] cmdArgs)
    {
        var args = RunOptions.Args.Skip(1).ToArray();   // Release: luôn rỗng (chỉ double-click); Debug: cờ kiểm thử
        var rt = Array.IndexOf(args, "--rollbacktest");
        if (rt >= 0 && rt + 1 < args.Length) { RollbackTest(args[rt + 1]); return; }
        if (args.Contains("--rollback")) { if (AppUpdate.PrevVersion != null) AppUpdate.LaunchRollback(auto: false); return; }   // GatewayApp.exe --rollback: quay về bản trước rồi mở lại
        var test = new[] { "--updatetest", "--backuptest", "--selftest", "--edittest", "--pairtest", "--freshtest", "--slottest", "--solshot", "--iconsheet", "--lantest", "--fbtest", "--iotest", "--offlinetest", "--otatest", "--lancloud", "--boardctl", "--lanadmin", "--lansweep", "--boarddo", "--lanwifi", "--lanui", "--wifisetup", "--devshot" }.Any(args.Contains);
        if (!test && AppUpdate.StartupGuard()) return;   // bản mới vừa cập nhật mà khởi động lỗi nhiều lần → đã tự quay về bản trước
        var ut = Array.IndexOf(args, "--updatetest");
        if (ut >= 0 && ut + 1 < args.Length) { UpdateTest(args[ut + 1]); return; }
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
                var bt = Array.IndexOf(args, "--backuptest");
                if (bt >= 0 && bt + 1 < args.Length) form.Shown += async (_, _) => await form.BackupTestAsync(args[bt + 1]);
                var lt = Array.IndexOf(args, "--lantest");
                if (lt >= 0 && lt + 1 < args.Length) form.Shown += async (_, _) => await form.LanTestAsync(args[lt + 1]);
                var fbt = Array.IndexOf(args, "--fbtest");
                if (fbt >= 0 && fbt + 1 < args.Length) form.Shown += async (_, _) => await form.FbTestAsync(args[fbt + 1]);
                var iot = Array.IndexOf(args, "--iotest");
                if (iot >= 0 && iot + 1 < args.Length) form.Shown += async (_, _) => await form.IoTestAsync(args[iot + 1]);
                var oft = Array.IndexOf(args, "--offlinetest");
                if (oft >= 0 && oft + 1 < args.Length) form.Shown += async (_, _) => await form.OfflineTestAsync(args[oft + 1]);
                var ota = Array.IndexOf(args, "--otatest");
                if (ota >= 0 && ota + 1 < args.Length) form.Shown += async (_, _) => await form.OtaTestAsync(args[ota + 1]);
                var lc = Array.IndexOf(args, "--lancloud");
                if (lc >= 0 && lc + 1 < args.Length) form.Shown += async (_, _) => await form.LanCloudAsync(args[lc + 1]);
                var bc = Array.IndexOf(args, "--boardctl");
                if (bc >= 0 && bc + 1 < args.Length) form.Shown += async (_, _) => await form.BoardCtlTestAsync(args[bc + 1]);
                var la = Array.IndexOf(args, "--lanadmin");
                if (la >= 0 && la + 1 < args.Length) form.Shown += async (_, _) => await form.LanAdminAsync(args[la + 1]);
                var sw = Array.IndexOf(args, "--lansweep");
                if (sw >= 0 && sw + 1 < args.Length) form.Shown += async (_, _) => await form.LanSweepAsync(args[sw + 1]);
                var bd = Array.IndexOf(args, "--boarddo");
                if (bd >= 0 && bd + 1 < args.Length) form.Shown += async (_, _) => await form.BoardDoTestAsync(args[bd + 1]);
                var lw = Array.IndexOf(args, "--lanwifi");
                if (lw >= 0 && lw + 1 < args.Length) form.Shown += async (_, _) => await form.LanWifiAsync(args[lw + 1]);
                var lu = Array.IndexOf(args, "--lanui");
                if (lu >= 0) form.Shown += async (_, _) => await form.LanUiAsync();
                if (args.Contains("--wifisetup")) form.Shown += async (_, _) => { form.Hide(); await form.WifiSetupAsync(); form.Close(); };
                var ds = Array.IndexOf(args, "--devshot");
                if (ds >= 0 && ds + 1 < args.Length) form.Shown += async (_, _) => await form.DevShotAsync(args[ds + 1]);
                var m = Array.IndexOf(args, "--edittest");
                if (m >= 0 && m + 1 < args.Length) form.Shown += async (_, _) => await form.EditTestAsync(args[m + 1]);
            }
            first = false;
            Application.Run(form);
        }
    }

    /// <summary>
    ///   GatewayApp.exe --updatetest KQ.txt   không giao diện: hỏi VPS bản mới → tải → kiểm sha256 → cài → tự mở lại (cũng với --updatetest). Ghi kết quả từng bước vào KQ.txt.
    /// </summary>
    static void UpdateTest(string result)
    {
        void Log(string t) => File.AppendAllText(result, $"{DateTime.Now:HH:mm:ss} v={AppUpdate.LocalVersion} {t}{Environment.NewLine}");
        var server = GatewayApp.CloudPage.DefaultServer;
        var info = AppUpdate.CheckAsync(server).GetAwaiter().GetResult();
        if (info == null) { Log("up-to-date (không có bản mới)"); return; }
        Log($"co ban moi {info.Version} ({info.Size} bytes) apiLevel={info.ApiLevel} breaking={info.Breaking}");
        var (err, stage) = AppUpdate.DownloadAsync(server, info, _ => { }).GetAwaiter().GetResult();
        if (err != null || stage == null) { Log("LOI tai: " + err); return; }
        Log("da tai + kiem sha256, goi trinh cai");
        // "bad": cố ý làm hỏng file chạy trong gói để thử đường tự quay về bản cũ của trình cài
        var bad = RunOptions.Args.Contains("bad");
        if (bad) File.Copy(Path.Combine(Environment.SystemDirectory, "whoami.exe"), Path.Combine(stage, Path.GetFileName(Environment.ProcessPath!)), true);   // exe hợp lệ nhưng thoát ngay = giả lập crash lúc khởi động
        AppUpdate.LaunchInstaller(stage, info.Version, healthCheck: bad);
    }

    /// <summary>--rollbacktest KQ.txt: không giao diện; quay về bản trước (nếu có) rồi tự mở lại (lần mở lại không còn bản trước nên chỉ ghi kết quả).</summary>
    static void RollbackTest(string result)
    {
        void Log(string t) => File.AppendAllText(result, $"{DateTime.Now:HH:mm:ss} v={AppUpdate.LocalVersion} {t}{Environment.NewLine}");
        var prev = AppUpdate.PrevVersion;
        if (prev == null) { Log("khong co ban truoc"); return; }
        Log($"quay ve ban truoc {prev}");
        AppUpdate.LaunchRollback(auto: false);
    }
}
