using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Sao lưu / khôi phục (xem BackupService, Pages/BackupPage.cs): tự động mỗi ngày, trước mỗi lần cập nhật, trước khi khôi phục.</summary>
public sealed partial class MainForm
{
    BackupService? _backup;
    BackupPage _backupPage = null!;
    DateTime _nextAutoBackup = DateTime.UtcNow.AddMinutes(2);   // để app khởi động xong, cấu hình ổn định rồi mới sao lưu
    bool _autoBackingUp;

    internal BackupService Backup => _backup ??= new BackupService(SettingsPath, Path.GetDirectoryName(Path.GetFullPath(SettingsPath))!,
        AppUpdate.LocalVersion ?? "dev", ConfigMigrations.Current, GatewayActivation.MachineId());

    /// <summary>Thời điểm bản sao lưu gần nhất (báo lên server để cảnh báo gateway lâu không sao lưu).</summary>
    internal DateTime? LastBackupAt { get { try { return Backup.LastBackupAt; } catch { return null; } } }

    /// <summary>Gọi từ Tick: tới hạn thì sao lưu tự động nền (không hiện hộp thoại; chưa có khoá thì bỏ qua — người dùng tạo khoá ở trang Sao lưu).</summary>
    void BackupTick()
    {
        if (_testMode || _autoBackingUp || DateTime.UtcNow < _nextAutoBackup) return;
        _nextAutoBackup = DateTime.UtcNow.AddMinutes(30);
        try { if (!Backup.AutoDue(DateTime.Now)) return; } catch { return; }
        _autoBackingUp = true;
        try { SaveCfg(); } catch (IOException) { }
        _ = Task.Run(() =>
        {
            try { var i = Backup.Create("auto"); _log.Add("INFO", "backup", $"đã sao lưu tự động: {i.Name} ({i.Size / 1024.0:0.#} KB)"); }
            catch (Exception e) { _log.Add("WARN", "backup", "sao lưu tự động lỗi: " + e.Message); }
            finally { _autoBackingUp = false; }
        });
    }

    /// <summary>Sao lưu ngay. interactive: chưa có khoá thì tạo và hiện khoá để người dùng cất (BẮT BUỘC cất ngoài máy).</summary>
    internal async Task BackupNowAsync(string reason, bool interactive)
    {
        if (interactive && !Backup.HasKey)
        {
            var key = Backup.CreateKey();
            KeyPrompt.Show(this, "Khoá khôi phục",
                "ĐÂY LÀ KHOÁ KHÔI PHỤC. Hãy chép/ghi lại và cất NGOÀI máy này (giấy, điện thoại, quản lý mật khẩu).\n\nKhông có khoá này thì không mở được bản sao lưu — nhất là khi máy hỏng hoặc đổi máy. Khoá đã được chép vào clipboard.", key);
        }
        if (!Backup.HasKey) return;
        try { SaveCfg(); } catch (IOException) { }
        var info = await Task.Run(() => Backup.Create(reason));
        _log.Add("INFO", "backup", $"đã sao lưu ({reason}): {info.Name}");
        Toast("Đã sao lưu: " + info.At.ToString("dd/MM HH:mm") + (Backup.LastExtraError is { } e ? $" — nhưng chép sang thư mục thứ hai lỗi: {e}" : ""), Backup.LastExtraError != null);
    }

    internal async Task ShowRecoveryKeyAsync()
    {
        if (!await EnsureUnlockedAsync("Nhập mật khẩu gateway để xem khoá khôi phục")) return;
        var key = Backup.LoadKey();
        if (key == null) { Toast(Backup.HasKey ? "Khoá trên máy này không đọc được (file chép từ máy khác) — dùng khoá bạn đã cất." : "Chưa có khoá — bấm \"Sao lưu ngay\" để tạo.", true); return; }
        KeyPrompt.Show(this, "Khoá khôi phục", "Khoá khôi phục của gateway này (đã chép vào clipboard). Cất ngoài máy.", key);
    }

    /// <summary>Khôi phục từ một gói: thử khoá lưu trên máy, không được thì hỏi; xác nhận; ghi đè; dựng lại cửa sổ với dữ liệu mới.</summary>
    internal async Task RestoreAsync(string file)
    {
        if (!await EnsureUnlockedAsync("Nhập mật khẩu gateway để khôi phục sao lưu")) return;
        var key = Backup.LoadKey() ?? "";
        var r = await Task.Run(() => Backup.Restore(file, key, apply: false));
        while (!r.Ok && r.Error is { } err && err.StartsWith("Sai khoá"))
        {
            var typed = KeyPrompt.Ask(this, "Khoá khôi phục", "Nhập khoá khôi phục của bản sao lưu này (dạng XXXXX-XXXXX-XXXXX-XXXXX):");
            if (typed == null) return;
            key = typed;
            r = await Task.Run(() => Backup.Restore(file, key, apply: false));
        }
        if (!r.Ok) { Toast("Không khôi phục được: " + r.Error, true); return; }
        var i = r.Info!;
        var warn = r.OtherMachine ? "\n\n⚠ Bản này tạo trên MÁY KHÁC. Khoá riêng và mật khẩu được giữ, nhưng giấy phép gắn máy (nếu có) cần admin cấp lại cho máy này." : "";
        if (!Ask.Yes(this, $"Khôi phục bản sao lưu {i.At:dd/MM/yyyy HH:mm} ({i.AppVersion})?\n\nCấu hình hiện tại sẽ bị thay thế (có tự sao lưu lại một bản 'trước khôi phục'). Gateway sẽ tự mở lại.{warn}", "Khôi phục sao lưu")) return;
        var done = await Task.Run(() => Backup.Restore(file, key, apply: true));
        if (!done.Ok) { Toast("Khôi phục lỗi: " + done.Error, true); return; }
        _log.Add("INFO", "backup", $"đã khôi phục từ {i.Name}");
        CopyFrom(done.Config!);   // FormClosing sẽ SaveCfg(_cfg): phải là dữ liệu vừa khôi phục, không phải bản cũ
        RebuildWindow("Đã khôi phục sao lưu " + i.At.ToString("dd/MM HH:mm"));
    }

    /// <summary>Dựng lại cửa sổ trong cùng tiến trình (đọc lại cấu hình/nhãn từ đĩa), giữ trạng thái mở khoá. Giống đổi giao diện giải pháp.</summary>
    void RebuildWindow(string msg)
    {
        Toast(msg);
        _ = Task.Delay(400).ContinueWith(_ => { if (!IsDisposed) BeginInvoke(async () => { await StopAsync(); _carry = (_login, _loginAt, msg); _carryLocal = _localUnlocked; RestartRequested = true; Close(); }); });
    }

    /// <summary>--backuptest KQ.txt (cần GATEWAYAPP_SETTINGS riêng): sao lưu → sửa cấu hình → khôi phục → dựng lại cửa sổ → thoát. Ghi từng bước vào KQ.txt để kiểm file trên đĩa sau khi thoát.</summary>
    internal async Task BackupTestAsync(string result)
    {
        void Log(string t) => File.AppendAllText(result, $"{DateTime.Now:HH:mm:ss} {t}{Environment.NewLine}");
        string DiskSite() => ConfigStore.Load(SettingsPath).Site;
        try
        {
            _cfg.Site = "truoc-khi-sua"; _cfg.CloudPassword = "mat-khau-bi-mat"; SaveCfg();
            var key = Backup.CreateKey();
            await BackupNowAsync("manual", interactive: false);
            Log($"da sao luu; site tren dia={DiskSite()}; so ban={Backup.List().Count}");
            _cfg.Site = "SAU-KHI-SUA"; SaveCfg();
            Log($"da sua; site tren dia={DiskSite()}");
            Ask.Override = true;
            await RestoreAsync(Backup.List().First(i => i.Reason == "manual").Path);
            Log($"da khoi phuc; site trong bo nho={_cfg.Site}; tren dia={DiskSite()}; pass={ConfigStore.Load(SettingsPath).CloudPassword}; pre-restore={Backup.List().Any(i => i.Reason == "pre-restore")}");
            await Task.Delay(2500);   // cho cửa sổ dựng lại
            Log($"sau khi dung lai cua so; site tren dia={DiskSite()}");
        }
        catch (Exception e) { Log("LOI " + e); }
        Application.Exit();
    }
}
