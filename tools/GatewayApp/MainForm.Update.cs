using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>Nút "Cập nhật" ở đầu trang: hiện khi VPS có bản GatewayApp mới hơn bản đang chạy (xem AppUpdate).</summary>
public sealed partial class MainForm
{
    readonly FlatButton _updBtn = new() { Caption = "⬆ Cập nhật", Width = 120, Primary = true, Visible = false };
    /// <summary>Chỉ hiện khi có bản trước để quay về (sau một lần cập nhật).</summary>
    readonly FlatButton _rbBtn = new() { Caption = "↩ Bản trước", Width = 120, Visible = false };
    UpdateInfo? _updInfo;
    bool _updChecking, _updBusy;
    DateTime _nextUpdCheck = DateTime.UtcNow.AddSeconds(15);

    void InitUpdateButton()
    {
        _updBtn.Click += async (_, _) => await RunUpdateAsync();
        _rbBtn.Click += async (_, _) => await RunRollbackAsync();
    }

    /// <summary>Gọi từ Tick: hỏi VPS định kỳ (không chặn giao diện) và hiện/ẩn nút.</summary>
    void UpdateTick()
    {
        if (_testMode || _updBusy) return;
        AppUpdate.MarkHealthyIfDue();   // chạy đủ 90 giây sau cập nhật → bản mới coi là khoẻ
        var canBack = AppUpdate.PrevVersion != null;
        if (_rbBtn.Visible != canBack) { _rbBtn.Visible = canBack; LayoutHead(); }
        var show = _updInfo != null;
        if (_updBtn.Visible != show) { _updBtn.Visible = show; if (show) { _updBtn.Caption = _updInfo!.Breaking ? "⬆ Cập nhật (bắt buộc)" : "⬆ Cập nhật"; _updBtn.Width = _updInfo.Breaking ? 190 : 120; } LayoutHead(); }
        if (_updChecking || DateTime.UtcNow < _nextUpdCheck) return;
        _updChecking = true;
        _nextUpdCheck = DateTime.UtcNow.AddMinutes(30);
        var server = CloudPage.ServerOf(_cfg);
        _ = Task.Run(async () => { var i = await AppUpdate.CheckAsync(server); _updInfo = i; _updChecking = false; });
    }

    async Task RunUpdateAsync()
    {
        var info = _updInfo;
        if (info == null || _updBusy) return;
        if (!await EnsureUnlockedAsync("Nhập mật khẩu gateway để cập nhật phần mềm")) return;
        if (!Ask.Yes(this, $"Có bản gateway mới ({info.Version}, {info.Size / 1024.0 / 1024.0:0.#} MB).{(info.Breaking ? "\nBản này đổi cách nối với server: bản đang chạy sẽ không còn hoạt động đúng nếu không cập nhật." : "")}\n\nCập nhật bây giờ? Gateway sẽ tự đóng và mở lại (vài giây gián đoạn).", "Cập nhật gateway")) return;
        _updBusy = true; _updBtn.Enabled = false;
        var server = CloudPage.ServerOf(_cfg);
        var (err, stage) = await AppUpdate.DownloadAsync(server, info, p => BeginInvoke(() => { _updBtn.Caption = $"Đang tải {p}%"; }));
        if (err != null || stage == null)
        {
            _updBusy = false; _updBtn.Enabled = true; _updBtn.Caption = info.Breaking ? "⬆ Cập nhật (bắt buộc)" : "⬆ Cập nhật";
            Toast("Cập nhật lỗi: " + err, error: true);
            return;
        }
        try
        {
            try { SaveCfg(); } catch (IOException) { }
            try { if (Backup.HasKey) Backup.Create("pre-update"); } catch (Exception) { /* không có bản trước cập nhật cũng không chặn cập nhật */ }
            AppUpdate.LaunchInstaller(stage, info.Version);
        }
        catch (Exception e)
        {
            _updBusy = false; _updBtn.Enabled = true; _updBtn.Caption = "⬆ Cập nhật";
            Toast("Không chạy được trình cài: " + e.Message, error: true);
            return;
        }
        Toast("Đang cài bản mới, gateway sẽ tự mở lại…");
        Application.Exit();
    }

    /// <summary>Người dùng chủ động quay về bản trước (cấu hình cục bộ được giữ; nếu định dạng cấu hình đã đổi thì dùng lại bản sao lưu trước khi nâng cấp).</summary>
    async Task RunRollbackAsync()
    {
        var prev = AppUpdate.PrevVersion;
        if (prev == null || _updBusy) return;
        if (!await EnsureUnlockedAsync("Nhập mật khẩu gateway để quay về bản trước")) return;
        if (!Ask.Yes(this, $"Quay về bản gateway trước ({prev})?\n\nGateway sẽ tự đóng và mở lại. Bản hiện tại sẽ không được đề nghị cập nhật lại cho tới khi có bản mới hơn.", "Quay về bản trước")) return;
        _updBusy = true;
        try { try { SaveCfg(); } catch (IOException) { } AppUpdate.LaunchRollback(auto: false); }
        catch (Exception e) { _updBusy = false; Toast("Không quay về được: " + e.Message, error: true); return; }
        Toast("Đang quay về bản trước, gateway sẽ tự mở lại…");
        Application.Exit();
    }
}
