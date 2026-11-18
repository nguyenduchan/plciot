using System.Collections.Concurrent;
using System.Text.Json;
using GatewayApp.Ui;
using Plciot.Scada;
using Plciot.Scada.Services.Ui;

namespace GatewayApp;

/// <summary>
/// Gateway C# có giao diện: dashboard tối kiểu Grafana vẽ bằng GDI+ (C# thuần, không web, không CDN → chạy offline).
/// Trang: Tổng quan · Thiết bị (thêm thiết bị ngoại vi, kèm giao thức/kết nối) · Cloud (tuỳ chọn) · Nhật ký.
/// Điều khiển đi qua đúng đường của gateway (ScadaCore.ExecuteKeyAsync): whitelist + giới hạn Min/Max.
/// </summary>
public sealed partial class MainForm : Form, IGatewayApp
{
    readonly ScadaConfig _cfg = Defaults();
    readonly UiMetaStore _meta;
    readonly HistoryStore _history = new();
    readonly ConcurrentDictionary<string, double> _values = new();
    ScadaHost? _host;
    bool _demo;
    /// <summary>--customer: bản của khách — chỉ giám sát và điều khiển; thiết lập do tool admin gửi qua IP (xem MainForm.Remote.cs).</summary>
    readonly bool _customer = Environment.GetCommandLineArgs().Contains("--customer");
    /// <summary>Gateway KHÔNG sửa thiết bị/giao thức: mọi thiết lập chỉ làm qua tool Admin. Chỉ các chế độ kiểm thử/trình diễn mới mở lại giao diện sửa.</summary>
    /// <summary>Tự chạy gateway sau mỗi lần lưu cấu hình (trừ các chế độ kiểm thử tự điều khiển việc chạy).</summary>
    bool AutoRun => !new[] { "--selftest", "--edittest", "--pairtest", "--autodemo" }.Any(Environment.GetCommandLineArgs().Contains);
    readonly bool _testMode = new[] { "--selftest", "--pairtest", "--autodemo", "--shot", "--edittest", "--soltest", "--freshtest", "--slottest", "--solshot" }.Any(Environment.GetCommandLineArgs().Contains);
    /// <summary>Bản đầy đủ (đã gộp tool Admin): có trang Thiết bị / Cloud. Bản khách (--customer) chỉ xem + điều khiển.</summary>
    bool _editUi => !_customer || _testMode;

    // ---- đăng nhập + mở khoá chỉnh sửa (duyệt qua trình duyệt, xem LoginForm) ----
    /// <summary>Token đăng ký do server cấp sống 30 phút; quá 25 phút coi như hết để không gửi token chết.</summary>
    static readonly TimeSpan TokenLife = TimeSpan.FromMinutes(25);
    LoginResult? _login;
    DateTime _loginAt = DateTime.MinValue;
    bool _prompting;
    /// <summary>TẠM THỜI (theo yêu cầu): --noauth bỏ qua màn hình đăng nhập/OTP để test đầy đủ gateway. Bỏ cờ này trước khi phát hành.</summary>
    readonly bool _noAuth = Environment.GetCommandLineArgs().Contains("--noauth");
    /// <summary>OTP chỉ cần MỘT lần cho mỗi lần mở app (không hết hạn giữa chừng); mở lại gateway thì phải nhập lại để sửa.</summary>
    bool Unlocked => _testMode || _noAuth || _login != null || _localUnlocked;
    /// <summary>Đã mở khoá bằng MẬT KHẨU CỤC BỘ (không cần webapp/Internet). Giữ khi dựng lại cửa sổ.</summary>
    bool _localUnlocked;
    static bool _carryLocal;
    /// <summary>Hộp thoại/nút sửa cấu hình gọi trước khi sửa: chưa OTP thì hiện màn hình OTP; false = bị từ chối.</summary>
    public bool RequireEdit() => EnsureUnlockedAsync().GetAwaiter().GetResult();   // EnsureUnlockedAsync không có await: hoàn tất đồng bộ
    // Gateway khởi động là TỰ CHẠY NỀN và nối server bằng khoá riêng của máy. Login/OTP chỉ cần khi: đăng ký lần đầu, hoặc chỉnh sửa cấu hình.

    readonly Panel _side = new() { Dock = DockStyle.Left, Width = 210, BackColor = Theme.Side };
    readonly Panel _head = new() { Dock = DockStyle.Top, Height = 62, BackColor = Theme.Bg };
    readonly Panel _body = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg };
    readonly Label _pageTitle = new() { ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(22, 12), BackColor = Color.Transparent, UseMnemonic = false };   // "&" trong tên giải pháp (P&ID, Cấp nước & trạm bơm) là chữ thường
    readonly StatusChip _chipPlc = new(), _chipCloud = new(), _chipMode = new();
    readonly FlatButton _demoBtn = new() { Caption = "Demo: tắt", Width = 110 };
    /// <summary>Trạng thái khoá luôn hiện ở đầu trang: người vận hành biết ngay có sửa/điều khiển được không, và khoá lại khi rời máy.</summary>
    readonly FlatButton _lockBtn = new() { Caption = "🔒 Mở khoá", Width = 130 };
    readonly Label _toast = new() { AutoSize = false, Height = 40, Visible = false, ForeColor = Color.White, BackColor = Theme.Accent, Font = Theme.Semi, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0) };
    readonly System.Windows.Forms.Timer _ui = new() { Interval = 500 };
    readonly System.Windows.Forms.Timer _toastTimer = new() { Interval = 4000 };

    readonly DashboardPage _dash;
    readonly DevicesPage _devices;
    readonly AdminAccessPage _access = new() { Dock = DockStyle.Fill };
    CloudPage _cloud = null!;
    readonly LogPage _log = new();
    readonly List<(NavButton Btn, Control Page, string Title)> _pages = new();
    Control _current = null!;

    static ScadaConfig Defaults() => new()
    {
        Site = "factory1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "", PollMs = 300,
        Mobile = MobileAccess.Off, LocalBrokerEnabled = false, LocalBind = "0.0.0.0", WebEnabled = false,
        LocalUsers = new() { new LocalUser { User = "gw", Password = "", Role = LocalRole.Device } },
        CloudTelemetryMinMs = 2000,
    };

    internal static string SettingsPath => Environment.GetEnvironmentVariable("GATEWAYAPP_SETTINGS") is { Length: > 0 } p ? p : ConfigStore.PathFor("gateway-app");

    // ------------------------------------------------------------------ IGatewayApp
    public ScadaConfig Config => _cfg;
    public UiMetaStore Meta => _meta;
    public HistoryStore History => _history;
    public bool Running => _host != null;
    public bool TryValue(string key, out double v) => _values.TryGetValue(key, out v);

    public async Task<string?> WriteAsync(string child, string field, double value)
    {
        var h = _host;
        if (h == null) return "gateway chưa chạy";
        if (!await EnsureUnlockedAsync("Nhập mật khẩu gateway để điều khiển thiết bị")) return "cần mở khoá (mật khẩu gateway) để điều khiển";
        var payload = JsonSerializer.SerializeToUtf8Bytes(new { id = Guid.NewGuid().ToString("N")[..8], child, key = field, v = value });
        string? ack;
        try { ack = await h.Core.ExecuteKeyAsync(payload, ControlSource.LocalScreen, "ui"); }
        catch (Exception e) { return e.Message; }
        if (ack == null) return null;            // chế độ gateway ESP32: ack đến sau
        using var d = JsonDocument.Parse(ack);
        if (d.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True) return null;
        return d.RootElement.TryGetProperty("err", out var e2) ? e2.GetString() : "lỗi";
    }

    public async Task<string?> SetDeviceEnabledAsync(string child, bool enabled)
    {
        var items = _cfg.Pack.Where(p => p.Child == child).ToList();
        if (items.Count == 0) return "không có thiết bị này";
        foreach (var p in items) p.Enabled = enabled;   // bộ đọc xem cấu hình mỗi chu kỳ → có hiệu lực ngay, không cần khởi động lại
        foreach (var p in items) { var k = UiMetaStore.Key(child, p.Field); if (!enabled) _values.TryRemove(k, out _); }
        _rev++;
        try { SaveCfg(); } catch (IOException) { }
        Toast(enabled ? $"Thiết bị {child} đang chạy" : $"Thiết bị {child} đã tạm dừng");
        await Task.CompletedTask;
        return null;
    }

    public async Task ApplyAsync(string why)
    {
        try { SaveCfg(); } catch (IOException) { /* không quan trọng */ }
        _rev++;
        // Gateway luôn tự chạy: lưu cấu hình xong là chạy lại (kể cả khi lần chạy trước lỗi và host đang dừng). Chế độ kiểm thử tự điều khiển việc chạy.
        var wasRunning = _host != null;
        if (wasRunning) await StopAsync();
        if (AutoRun || wasRunning) await StartAsync();
        if (_host != null || !AutoRun) Toast(why);   // chạy lỗi thì giữ nguyên thông báo lỗi của StartAsync
    }

    /// <summary>Thông báo cuối cùng (kiểm thử đọc lại kết quả thao tác).</summary>
    internal (string Text, bool Error) LastToast { get; private set; }

    public void Toast(string text, bool error = false)
    {
        if (InvokeRequired) { BeginInvoke(() => Toast(text, error)); return; }
        LastToast = (text, error);
        _toast.Text = text; _toast.BackColor = error ? Theme.Red : Theme.Accent; _toast.Visible = true; _toast.BringToFront();
        PlaceToast(); _toastTimer.Stop(); _toastTimer.Start();
    }

    void PlaceToast()
    {
        var w = Math.Min(760, ClientSize.Width - 260);
        _toast.Size = new Size(Math.Max(240, w), 40);
        _toast.Location = new Point(_side.Width + 20, ClientSize.Height - 60);
    }

    /// <summary>Chế độ demo không ghi đè cấu hình thật của người dùng.</summary>
    void SaveCfg() { if (!_demo) ConfigStore.Save(SettingsPath, _cfg); }

    // ------------------------------------------------------------------ dựng giao diện
    public MainForm()
    {
        Text = _customer ? "Plciot GATEWAY (bản khách) — giám sát và điều khiển" : "Plciot GATEWAY (bản đầy đủ) — giám sát và điều khiển; thiết lập qua tool Admin";
        Width = 1400; Height = 860; MinimumSize = new Size(1100, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; DoubleBuffered = true;
        _meta = new UiMetaStore(SettingsPath);
        try { if (File.Exists(SettingsPath)) CopyFrom(ConfigStore.Load(SettingsPath)); } catch (Exception e) when (e is IOException or JsonException) { /* dùng mặc định */ }

        _dash = new DashboardPage(this) { Dock = DockStyle.Fill, ReadOnly = !_editUi };
        _devices = new DevicesPage(this) { Dock = DockStyle.Fill };
        _cloud = new CloudPage(this) { Dock = DockStyle.Fill };
        _log.Dock = DockStyle.Fill;

        // thanh bên
        // đầu thanh bên: icon giải pháp (vector, giống webapp) + tên + phiên bản
        var brand = new Brand { Title = SolutionHost.Title.Length > 0 ? SolutionHost.Title : "Gateway", IconId = SolutionHost.Icon.Length > 0 ? SolutionHost.Icon : "grid", Sub = _customer ? "PLCIOT · BẢN KHÁCH" : "PLCIOT · BẢN ĐẦY ĐỦ" };
        var items = new (string Icon, string Name, Control Page)[]
        {
            ("grid", "Tổng quan", _dash), ("device", "Thiết bị", _devices), ("cloud", "Cloud", _cloud), ("list", "Nhật ký", _log),
        };   // tool Admin đã gộp vào đây: không còn trang "Kết nối admin" (không mở cổng cho tool ngoài)
        if (!_editUi) items = items.Where(x => x.Page == _dash || x.Page == _log).ToArray();   // bản khách: chỉ xem + điều khiển
        if (SolutionHost.ExtraPage is { } extra)   // MỘT gateway = MỘT loại UI: giao diện giải pháp GỘP vào trang chính (một mục, không tách "Tổng quan" riêng)
        {
            var x = extra(this);
            if (x.Page is IndustryPage ip) { ip.Merged = true; ip.AutoScroll = false; }
            _dash.Embed(x.Page);
            items = items.Select(it => it.Page == _dash ? (x.Icon, x.Name, (Control)_dash) : it).ToArray();
        }
        foreach (var (icon, name, page) in items)
        {
            var b = new NavButton { Icon = icon, Caption = name };
            var p = page; var n = page == _dash && SolutionHost.Heading.Length > 0 ? SolutionHost.Heading : name;   // trang giải pháp: thanh trên hiện tên đầy đủ
            b.Click += (_, _) => Show(p);
            _pages.Add((b, page, n)); page.Visible = false; _body.Controls.Add(page);
        }
        for (var i = _pages.Count - 1; i >= 0; i--) _side.Controls.Add(_pages[i].Btn);
        _side.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Side });
        _side.Controls.Add(brand);
        var ver = new Label { Text = "C# thuần · không cần Internet", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Bottom, Height = 34, Padding = new Padding(20, 0, 0, 0), TextAlign = ContentAlignment.MiddleLeft, BackColor = Theme.Side };
        _side.Controls.Add(ver);

        // thanh trên
        _head.Controls.Add(_pageTitle);
        _qrIcon = new QrIcon(this, () => CloudPage.DefaultServer);
        foreach (var c in new Control[] { _qrIcon, _lockBtn, _demoBtn, _chipMode, _chipCloud, _chipPlc }) _head.Controls.Add(c);
        _lockBtn.Click += async (_, _) => await ToggleLockAsync();
        if (_testMode || _noAuth) _lockBtn.Visible = false;
        _head.Resize += (_, _) => LayoutHead();
        _demoBtn.Click += async (_, _) => await ToggleDemoAsync();

        BuildLockScreen();
        Controls.Add(_lockScreen); Controls.Add(_body); Controls.Add(_head); Controls.Add(_side); Controls.Add(_toast);
        Resize += (_, _) => PlaceToast();
        _toastTimer.Tick += (_, _) => { _toast.Visible = false; _toastTimer.Stop(); };
        _qrIcon.Update();
        LayoutHead();
        Show(_dash);
        _dash.Rebuild();

        AutoLock.Install();
        _ui.Tick += (_, _) => Tick();
        _ui.Start();
        if (_carry.Login != null || _carry.Toast != null || _carryLocal)   // vừa dựng lại cửa sổ vì đổi giao diện: giữ trạng thái mở khoá, báo đã áp dụng
        {
            _login = _carry.Login; _loginAt = _carry.At; _localUnlocked = _carryLocal; var t = _carry.Toast; _carry = default; _carryLocal = false;
            if (!string.IsNullOrEmpty(t)) Shown += (_, _) => Toast(t);
        }
        Shown += (_, _) => BeginInvoke(async () => await StartupLoginAsync());   // hoãn: hộp thoại OTP (modal) không được chặn việc tự chạy nền ở các handler Shown khác;   // màn hình đăng nhập lúc mở app (bỏ qua ở chế độ kiểm thử / bản khách)
        FormClosing += async (_, _) => { try { SaveCfg(); } catch (IOException) { } await StopAsync(); };
        var args = Environment.GetCommandLineArgs();
        _demo = args.Contains("--demo");
        UpdateDemoButton();
        if (_customer || !_editUi) _demoBtn.Visible = false;
        // luôn tự chạy (kể cả chưa có thiết bị): thêm thiết bị là đọc ngay. Các chế độ kiểm thử tự điều khiển việc chạy.
        if (!args.Contains("--selftest") && !args.Contains("--edittest") && !args.Contains("--slottest") && !args.Contains("--pairtest") && !args.Contains("--autodemo")) Shown += async (_, _) => await StartAsync();
        Shown += (_, _) => InitRemoteAccess(args);
        // Đổi giải pháp (UI) dựng lại cửa sổ trong CÙNG tiến trình: timer của cửa sổ cũ phải dừng, nếu không nó vẫn chạy Tick()
        // trên các điều khiển đã huỷ (vd. thêm dòng vào bảng nhật ký đã mất cột → crash "No row can be added…").
        FormClosed += (_, _) => { _ui.Stop(); _toastTimer.Stop(); _codeTimer.Stop(); _ui.Dispose(); _toastTimer.Dispose(); _codeTimer.Dispose(); _api?.Dispose(); };
    }

    QrIcon _qrIcon = null!;

    void LayoutHead()
    {
        var x = _head.Width - 18;
        foreach (var c in new Control[] { _qrIcon, _lockBtn, _demoBtn, _chipMode, _chipCloud, _chipPlc })
        {
            if ((_customer || !_editUi) && c == _demoBtn) continue;
            if ((c == _qrIcon || c == _lockBtn) && !c.Visible) continue;
            x -= c.Width + 8; c.Location = new Point(x, c is StatusChip ? 17 : c == _qrIcon ? 11 : 14);
        }
    }

    /// <summary>Cổng chỉnh sửa: cần OTP MỘT lần cho mỗi lần mở app (qua webapp: duyệt đăng nhập hoặc mã ghép). Xem trang thì không cần.</summary>
    async Task<bool> EnsureUnlockedAsync(string why = "Xác nhận trên webapp để chỉnh sửa cấu hình gateway")
    {
        if (Unlocked) return true;
        if (_prompting) return false;
        _prompting = true;
        try
        {
            // Đã đặt mật khẩu cục bộ: mở khoá offline, không cần webapp. Quên mật khẩu → xác nhận bằng webapp (OTP/Authenticator) rồi đặt lại.
            var hadLocal = _cfg.LocalAdminHash.Length > 0;
            if (hadLocal)
            {
                var r = LocalPasswordForm.Unlock(this, _cfg.LocalAdminHash, why);
                if (r == DialogResult.OK) { _localUnlocked = true; Toast("Đã mở khoá."); return true; }
                if (r != DialogResult.Retry) return false;
            }
            using var f = new LoginForm(CloudPage.ServerOf(_cfg), "Đăng nhập gateway", why);
            if (f.ShowDialog(this) != DialogResult.OK || f.Result == null) return false;
            _login = f.Result; _loginAt = DateTime.UtcNow;
            Toast($"Đã đăng nhập ({f.Result.User}).");
            OfferLocalPassword(hadLocal);
            _ = AutoConnectAsync();
            return true;
        }
        finally { _prompting = false; }
    }

    /// <summary>
    /// MÀN HÌNH KHOÁ: đăng nhập chỉ hỏi ở ĐÚNG hai lúc — mới mở app và khi bấm "Khoá lại" (hoặc tự khoá vì không thao tác).
    /// Đã mở khoá thì mọi tính năng (sửa cấu hình, điều khiển…) dùng ngay, không hỏi lại. Đang khoá: màn hình che giao diện,
    /// gateway vẫn chạy nền + nối server bình thường.
    /// </summary>
    readonly Panel _lockScreen = new() { Dock = DockStyle.Fill, Visible = false };

    void BuildLockScreen()
    {
        _lockScreen.BackColor = Theme.Bg;
        var box = new Panel { Size = new Size(460, 210), BackColor = Theme.Panel };
        var t = new Label { Text = "🔒  Gateway đang khoá", Font = new Font("Segoe UI Semibold", 16f), ForeColor = Theme.Text, AutoSize = false, Location = new Point(24, 22), Size = new Size(412, 34), BackColor = Color.Transparent };
        var d = new Label { Text = "Gateway vẫn chạy nền và nối server. Đăng nhập để xem và thao tác trên máy này.", ForeColor = Theme.Muted, AutoSize = false, Location = new Point(24, 64), Size = new Size(412, 48), BackColor = Color.Transparent };
        var go = new FlatButton { Caption = "Đăng nhập", Primary = true, Width = 160, Location = new Point(24, 132) };
        go.Click += async (_, _) => await ShowLoginAsync();
        box.Controls.AddRange(new Control[] { t, d, go });
        _lockScreen.Controls.Add(box);
        _lockScreen.Resize += (_, _) => box.Location = new Point(Math.Max(0, (_lockScreen.Width - box.Width) / 2), Math.Max(0, (_lockScreen.Height - box.Height) / 2));
    }

    /// <summary>Hiện/ẩn màn hình khoá theo trạng thái (gọi mỗi nhịp Tick).</summary>
    void SyncLockScreen()
    {
        var locked = !Unlocked;
        if (_lockScreen.Visible == locked) return;
        _lockScreen.Visible = locked;
        if (locked) _lockScreen.BringToFront(); else _toast.BringToFront();
    }

    /// <summary>Khoá ngay rồi mở màn hình đăng nhập.</summary>
    void LockNow(string toast)
    {
        _localUnlocked = false; _login = null; _loginAt = DateTime.MinValue;
        SyncLockScreen();
        Toast(toast);
        BeginInvoke(async () => await ShowLoginAsync());
    }

    async Task ShowLoginAsync()
    {
        if (Unlocked) { SyncLockScreen(); return; }
        await EnsureUnlockedAsync("Đăng nhập để dùng gateway");
        SyncLockScreen();
    }

    /// <summary>Nút đầu trang: đang mở → khoá lại + hiện đăng nhập; đang khoá → hiện đăng nhập.</summary>
    async Task ToggleLockAsync()
    {
        if (!Unlocked) { await ShowLoginAsync(); return; }
        LockNow("Đã khoá. Gateway vẫn chạy và nối server.");
    }

    /// <summary>Sau khi chủ tài khoản đã xác thực trên webapp: mời đặt (hoặc đặt lại) mật khẩu cục bộ để lần sau mở khoá không cần webapp.</summary>
    void OfferLocalPassword(bool reset)
    {
        if (_testMode || _noAuth) return;
        var h = LocalPasswordForm.Create(this, reset ? "Đặt mật khẩu mới cho gateway này" : "Đặt mật khẩu gateway — lần sau mở khoá tại máy, không cần webapp");
        if (h == null) { if (reset) Toast("Giữ nguyên mật khẩu cũ."); return; }
        _cfg.LocalAdminHash = h;
        try { SaveCfg(); } catch (IOException) { }
        Toast("Đã đặt mật khẩu gateway.");
    }

    /// <summary>
    /// Chuyển gateway ĐÃ ĐĂNG KÝ sang PC này (đổi PC / cài lại Windows): chủ tài khoản đăng nhập (Authenticator hoặc OTP điện thoại),
    /// chọn gateway cũ; server đổi khoá công khai sang PC này, giữ tem/QR/id MQTT/thiết bị/lịch sử và ngắt PC cũ (xoay mật khẩu MQTT).
    /// </summary>
    async Task<bool> MigrateAsync()
    {
        var api = CloudPage.ServerOf(_cfg);
        using var f = new LoginForm(api, "Chuyển gateway sang PC này", "Đăng nhập tài khoản chủ gateway cũ");
        if (f.ShowDialog(this) != DialogResult.OK || f.Result == null) return false;
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(api.Trim()), Timeout = TimeSpan.FromSeconds(30) };
            var cli = new GatewayEnrollClient(http);
            var mine = await cli.MineAsync(f.Result.Token);
            if (mine.Count == 0) { Toast("Tài khoản này chưa có gateway nào để chuyển — hãy đăng ký mới.", true); return false; }
            var pick = GatewayPickerForm.Pick(this, mine);
            if (pick == null) return false;
            var r = await cli.RebindAsync(f.Result.Token, pick.Value.Site, pick.Value.Device, Identity());
            if (r.Kit == null || string.IsNullOrEmpty(r.Qr)) { Toast("Server không trả dữ liệu chuyển PC.", true); return false; }
            _login = f.Result; _loginAt = DateTime.UtcNow;
            _log.Add("INFO", "rebind", $"đã chuyển {r.Site}/{r.Device} sang PC này, ID máy {Identity().Hw}");
            var (ok, msg) = await ApplyKitAsync(r.Kit, r.Qr!, api);
            if (ok) { _cfg.LocalAdminHash = ""; OfferLocalPassword(false); }   // PC mới: đặt mật khẩu cục bộ mới (mật khẩu PC cũ không mang theo)
            return ok;
        }
        catch (Exception ex)
        {
            Toast(ex.Message switch { "not_found" => "Không tìm thấy gateway này trong tài khoản.", "invalid_proof" => "Đồng hồ máy lệch quá 5 phút so với server — chỉnh lại giờ rồi thử lại.", "unauthorized" or "session_revoked" => "Phiên đăng nhập hết hạn — thử lại.", _ => "Chuyển PC lỗi: " + ex.Message }, true);
            return false;
        }
    }

    bool _autoBusy;
    /// <summary>Sau đăng nhập: gateway CHƯA có ID + QR thì server tự cấp (đăng ký lần đầu) và đồng bộ. Đã đăng ký thì không làm gì (đã tự nối từ lúc khởi động).</summary>
    async Task AutoConnectAsync()
    {
        if ((_testMode && !_noAuth) || (_login == null && !_noAuth) || _autoBusy) return;
        _autoBusy = true;
        try
        {
            if (_cfg.MqttId.Length == 0 || _cfg.GatewayQr.Length == 0)
            {
                var r = await RegisterAsync(CloudPage.ServerOf(_cfg));
                if (r.Ok) Toast("Đã tự cấp ID + QR từ server và đồng bộ.");
            }
        }
        finally { _autoBusy = false; }
    }

    /// <summary>Token đăng ký còn dùng được không; không thì đăng nhập lại (một lần duyệt mới).</summary>
    async Task<LoginResult?> FreshLoginAsync()
    {
        if (_login != null && (_noAuth || DateTime.UtcNow - _loginAt < TokenLife)) return _login;
        _login = null; _loginAt = DateTime.MinValue;
        return await EnsureUnlockedAsync("Đăng nhập webapp để kết nối gateway với server") ? _login : null;
    }

    /// <summary>Màn hình đăng nhập lúc mở app. Huỷ → chạy ở chế độ chỉ xem (vẫn offline được).</summary>
    async Task StartupLoginAsync()
    {
        if (_noAuth)   // TẠM THỜI: không đăng nhập; nếu có token đăng ký lấy sẵn (env) thì dùng để tự cấp ID + QR
        {
            long.TryParse(Environment.GetEnvironmentVariable("GW_TEST_UID"), out var uid);
            if (Environment.GetEnvironmentVariable("GW_TEST_TOKEN") is { Length: > 0 } tk) { _login = new LoginResult(tk, "noauth", uid); _loginAt = DateTime.UtcNow; }
            _dash.ReadOnly = false; _dash.Rebuild();
            Toast("⚠ CHẾ ĐỘ KHÔNG XÁC THỰC (--noauth) — chỉ để test.", true);
            await AutoConnectAsync();
            return;
        }
        if (_testMode) return;
        var registered = _cfg.MqttId.Length > 0 && _cfg.GatewayQr.Length > 0;
        var machine = GatewayActivation.MachineId();
        if (registered && _cfg.BoundMachineId.Length > 0 && _cfg.BoundMachineId != machine)
        {
            // Config được SAO CHÉP sang PC khác (khoá riêng + mật khẩu cloud mã hoá theo máy nên không dùng được ở đây): không nhân bản gateway.
            if (Ask.Yes(this, "Cấu hình gateway này được tạo trên một PC khác nên PC này không nối cloud để tránh nhân bản.\n\nChuyển gateway sang PC này? (giữ QR, thiết bị, lịch sử; PC cũ sẽ bị ngắt)", "Gateway từ PC khác"))
                if (await MigrateAsync()) { await StopAsync(); await StartAsync(); return; }
            Toast("PC này chưa nối cloud (cấu hình thuộc PC khác).", true);
            return;
        }
        if (registered && _cfg.BoundMachineId.Length == 0) { _cfg.BoundMachineId = machine; try { SaveCfg(); } catch (IOException) { } }   // config cũ: gắn với PC hiện tại
        if (!registered && Ask.Yes(this, "PC này thay cho một PC gateway đã đăng ký trước đó?\n\nCó: chuyển gateway cũ sang PC này (giữ QR, thiết bị, lịch sử).\nKhông: đăng ký gateway mới.", "Cài đặt gateway"))
            if (await MigrateAsync()) return;
        // Đã đăng ký: gateway TỰ nối server bằng khoá riêng của máy, không hiện màn hình đăng nhập; sửa cấu hình/điều khiển tại máy mới hỏi (mật khẩu gateway hoặc webapp).
        // Mới mở app: LUÔN hiện màn hình đăng nhập (gateway đã tự chạy nền + nối server từ trước). Chưa đăng ký thì đăng nhập này cũng cấp ID + QR.
        SyncLockScreen();
        if (!await EnsureUnlockedAsync(registered ? "Đăng nhập để dùng gateway" : "Đăng ký gateway lần đầu: đăng nhập tài khoản webapp"))
            Toast(registered ? "Gateway đang khoá — vẫn chạy nền và nối server." : "Gateway chạy cục bộ; chưa đăng ký nên chưa nối server.");
        SyncLockScreen();
    }

    void Show(Control page)
    {
        _current = page;
        foreach (var (btn, p, title) in _pages)
        {
            var on = p == page; btn.Selected = on; btn.Invalidate(); p.Visible = on;
            if (on) _pageTitle.Text = title;
        }
        page.BringToFront();
        Tick();
    }

    /// <summary>Chỉ cho chế độ kiểm thử (--pairtest/--soltest): dùng token đăng ký lấy sẵn (env GW_TEST_TOKEN, GW_TEST_UID) thay vì mở trình duyệt.</summary>
    async Task TestRegisterAsync(string api, string token)
    {
        long.TryParse(Environment.GetEnvironmentVariable("GW_TEST_UID"), out var uid);
        _login = new LoginResult(token, "test", uid); _loginAt = DateTime.UtcNow;
        await RegisterAsync(api);
    }

    void CopyFrom(ScadaConfig s)
    {
        foreach (var p in typeof(ScadaConfig).GetProperties().Where(p => p.CanWrite && p.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), true).Length == 0))
            p.SetValue(_cfg, p.GetValue(s));
    }

    // ------------------------------------------------------------------ chạy / dừng
    async Task ToggleDemoAsync()
    {
        if (_customer || !_editUi) return;
        _demo = !_demo; UpdateDemoButton();
        _meta.Persist = !_demo;
        if (_demo && _cfg.Pack.Count == 0) DemoDriver.InstallSample(_cfg, _meta);
        else if (!_demo && DemoDriver.IsSample(_cfg)) { _cfg.Pack.Clear(); _meta.Reload(); }   // rời demo: bỏ bộ mẫu tạm, không lưu
        else if (!_demo) _meta.Reload();
        if (_host != null) { await StopAsync(); await StartAsync(); }
        else Toast(_demo ? "Demo bật: xem bồn nước + bơm mô phỏng ngay trong chương trình." : "Demo tắt.");
    }

    void UpdateDemoButton() { _demoBtn.Caption = _demo ? "Demo: BẬT" : "Demo: tắt"; _demoBtn.Primary = _demo; _demoBtn.Invalidate(); }

    async Task StartAsync()
    {
        if (_host != null) return;
        _meta.Persist = !_demo;
        if (_demo && _cfg.Pack.Count == 0) DemoDriver.InstallSample(_cfg, _meta);
        var err = _cfg.Validate();
        if (err != null) { Toast("Cấu hình chưa hợp lệ: " + err, true); return; }
        try { SaveCfg(); } catch (IOException) { }
        try
        {
            _values.Clear();
            var h = new ScadaHost(_cfg, _demo ? new DemoDriver(_cfg) : null);
            h.Describer = new MetaDescriber(_meta, _cfg);   // nhãn/đơn vị/kiểu từ hộp thoại thêm thiết bị → bản tin config
            h.Log += l => _log.Add("LOG", "gateway", l);
            h.Core.Traffic += (d, c, t) => _log.Add(d, c, t);
            h.Core.Publish += OnPublish;
            h.Core.ControlGate = () => Unlocked;   // điều khiển (ghi xuống PLC, kể cả từ cloud/điện thoại) chỉ sau khi đã nhập OTP
            _host = h;
            await h.StartAsync();
        }
        catch (LicenseRequiredException e) { await Abort(); Toast(e.Message, true); return; }
        catch (Exception e) { await Abort(); Toast("Không chạy được: " + e.Message, true); return; }
        Toast(_demo ? "Gateway đang chạy với PLC giả (demo)." : $"Gateway đang chạy: {_host!.Core.InfoLine}");
    }

    async Task Abort()
    {
        var h = _host; _host = null;
        if (h != null) { try { await h.DisposeAsync(); } catch (Exception) { /* bỏ qua */ } }
    }

    async Task StopAsync()
    {
        await Abort();
    }

    /// <summary>Telemetry schema:2 của gateway: {"d":{child:{field:số}}} — cùng dữ liệu gửi lên cloud.</summary>
    void OnPublish(string kind, byte[] payload, bool retain)
    {
        if (kind != "telemetry") return;
        try
        {
            using var doc = JsonDocument.Parse(payload);
            if (!doc.RootElement.TryGetProperty("d", out var d) || d.ValueKind != JsonValueKind.Object) return;
            foreach (var c in d.EnumerateObject())
                foreach (var f in c.Value.EnumerateObject())
                    if (f.Value.TryGetDouble(out var v)) { var k = UiMetaStore.Key(c.Name, f.Name); _values[k] = v; _history.Add(k, v); }
        }
        catch (JsonException) { /* bỏ qua gói hỏng */ }
    }

    // ------------------------------------------------------------------ cloud: do tool ADMIN điều khiển, gateway thực hiện
    public string FingerprintText => Fingerprint.Of(_cfg);

    public async Task<(bool Ok, string Msg)> CloudAsync(string action, string api, string value)
    {
        // Mọi việc đổi cấu hình/kết nối cloud cần một lần duyệt còn hiệu lực trên webapp (đọc danh sách giải pháp thì không)
        if (action == "migrate") { var ok = await MigrateAsync(); if (ok) { await StopAsync(); await StartAsync(); } return (ok, ok ? "Đã chuyển gateway sang PC này." : "Chưa chuyển gateway."); }   // tự đăng nhập chủ tài khoản bên trong
        if (action != "solutions" && !await EnsureUnlockedAsync()) return (false, "Cần mở khoá (mật khẩu gateway) để thực hiện.");
        if (action == "password") { OfferLocalPassword(_cfg.LocalAdminHash.Length > 0); return (true, ""); }
        return action switch
        {
            "register" => await RegisterAsync(api),
            "enroll" => await EnrollAsync(api, value),
            "solutions" => await SolutionsAsync(api),
            "solution" => await SetSolutionAsync(api, value),
            _ => (false, "việc cloud không hợp lệ"),
        };
    }

    GatewayIdentity? _identity;
    /// <summary>Danh tính mật mã của gateway (sinh lần đầu, lưu khoá riêng vào cấu hình đã mã hoá).</summary>
    GatewayIdentity Identity()
    {
        if (_identity != null) return _identity;
        var key = _cfg.GatewayKey;
        _identity = GatewayIdentity.LoadOrCreate(ref key, out var created);
        if (created) { _cfg.GatewayKey = key; try { SaveCfg(); } catch (IOException) { } }
        return _identity;
    }
    public string HwText => Identity().Hw;

    (bool, string) Done(bool ok, string msg) { Toast(msg, !ok); return (ok, msg); }
    /// <summary>Kết nối server bằng tài khoản đã đăng nhập (duyệt qua trình duyệt): gửi khoá công khai + chữ ký + bản khai; server cấp site/MQTT trong hạn mức của tài khoản, gateway tự cấu hình + đồng bộ.</summary>
    async Task<(bool Ok, string Msg)> RegisterAsync(string api)
    {
        var login = await FreshLoginAsync();
        if (login == null) return Done(false, "Chưa đăng nhập webapp.");
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(api.Trim()), Timeout = TimeSpan.FromSeconds(30) };
            var json = ConfigBuilder.Build(_cfg, new MetaDescriber(_meta, _cfg));   // đúng bản tin config sẽ publish sau khi đăng ký
            var r = await new GatewayEnrollClient(http).RegisterAsync(login.Token, login.Uid, Fingerprint.Of(_cfg), json, Identity(), _cfg.Solution);
            if (r.Approved && r.Kit != null && r.Qr != null)
            {
                _log.Add("INFO", "register", $"đã đăng ký: {r.Site}/{r.Device}, tài khoản {login.User}, ID máy {Identity().Hw}");
                return await ApplyKitAsync(r.Kit, r.Qr, api);
            }
            if (r.Status == "transfer_pending")
            {
                var when = r.DueAt > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(r.DueAt).LocalDateTime.ToString("HH:mm dd/MM") : "sau 24 giờ";
                _log.Add("INFO", "register", $"gateway thuộc tài khoản khác: đã gửi yêu cầu chuyển sang {login.User}, chờ chủ cũ duyệt (tự chuyển lúc {when})");
                return Done(true, $"Gateway đang thuộc tài khoản khác. Đã gửi yêu cầu chuyển sang \"{login.User}\": chủ cũ duyệt trên webapp thì chuyển ngay, không từ chối thì tự chuyển lúc {when}. Gateway vẫn chạy bình thường trong lúc chờ.");
            }
            if (r.Status == "transfer_done") return Done(true, $"Đã chuyển gateway sang tài khoản \"{login.User}\".");
            return Done(false, "Server chưa cấp gateway cho tài khoản này.");
        }
        catch (Exception ex) { return Done(false, ex.Message switch { "too_many_gateways" => "Tài khoản đã đạt số gateway tối đa.", "invalid_proof" => "Đồng hồ máy lệch quá 5 phút so với server — chỉnh lại giờ rồi thử lại.", "unauthorized" or "session_revoked" => "Phiên đăng nhập hết hạn — đăng nhập lại.", "rate_limited" => "Thao tác quá nhanh, thử lại sau.", "transfer_in_progress" => "Gateway đang có yêu cầu chuyển cho tài khoản khác — chờ yêu cầu đó xử lý xong.", "transfer_rejected" => "Chủ gateway đã từ chối chuyển cho tài khoản này — thử lại sau 24 giờ.", _ => "Kết nối lỗi: " + ex.Message }); }
    }

    /// <summary>Enroll từ QR của tem (cần Internet của gateway): nhận site/MQTT từ server.</summary>
    async Task<(bool Ok, string Msg)> EnrollAsync(string api, string qr)
    {
        if (string.IsNullOrWhiteSpace(qr)) return Done(false, "Dán mã QR của tem.");
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(api.Trim()), Timeout = TimeSpan.FromSeconds(15) };
            var kit = await new GatewayEnrollClient(http).EnrollAsync(qr.Trim(), Identity());
            if (kit == null) throw new InvalidOperationException("server không trả dữ liệu");
            return await ApplyKitAsync(kit, qr.Trim(), api);
        }
        catch (Exception ex) { return Done(false, "Enroll lỗi: " + ex.Message); }
    }

    /// <summary>Áp kit server trả (site/device/MQTT/pack) vào cấu hình, rồi chạy lại host để đồng bộ setting lên server.</summary>
    async Task<(bool Ok, string Msg)> ApplyKitAsync(GatewayProvisionKit kit, string qr, string api)
    {
        try
        {
            // Mặc định giao diện CƠ BẢN: gateway tự quyết giải pháp (đổi ở mục Cloud), không nhận giải pháp server gợi ý lúc đăng ký
            ApplySkin(kit);
            _cfg.GatewayQr = qr; _cfg.CloudApiUrl = api.Trim();
            if (!string.IsNullOrEmpty(kit.CmdKey)) _cfg.CloudCmdKey = kit.CmdKey;   // từ giờ chỉ nhận lệnh cloud có chữ ký của server
            _cfg.BoundMachineId = GatewayActivation.MachineId();
            _cfg.CloudSendData = kit.Claimed ?? true;   // chưa có user → chỉ đồng bộ setting
            _cfg.Site = kit.Site ?? _cfg.Site; _cfg.Device = kit.Device ?? _cfg.Device;
            // id MQTT ngẫu nhiên do server cấp: gateway ghép vào mọi topic (gw/<id>/<kind>); không có id thì không nối cloud được
            var mqttId = kit.MqttId ?? (kit.TopicBase is { } tb && tb.StartsWith(Contract.GwPrefix + "/") ? tb[(Contract.GwPrefix.Length + 1)..] : null);
            if (!Contract.IsMqttId(mqttId)) throw new InvalidOperationException("server không cấp id MQTT hợp lệ");
            _cfg.MqttId = mqttId!;
            if (kit.TelemetryMinMs is > 0) { _cfg.CloudTelemetryMinMs = kit.TelemetryMinMs.Value; _cfg.CloudTelemetryFastMs = kit.TelemetryMinMs.Value; }   // gói giới hạn tần suất: tự gửi chậm, không chờ server bỏ bớt
            if (kit.Mqtt != null)
            {
                _cfg.CloudUser = kit.Mqtt.Username ?? _cfg.CloudUser;
                _cfg.CloudPassword = kit.Mqtt.Password ?? _cfg.CloudPassword;
                if (!string.IsNullOrWhiteSpace(kit.Mqtt.PinSha256)) _cfg.CloudPinSha256 = kit.Mqtt.PinSha256.Replace(":", "").Trim();   // broker tự ký: server trao sẵn dấu vân tay
                if (Uri.TryCreate(kit.Mqtt.Mqtts, UriKind.Absolute, out var u)) { _cfg.CloudHost = u.Host; _cfg.CloudPort = u.Port; _cfg.CloudTransport = "mqtts"; }
            }
            // Pack: tem chỉ cho biết thiết bị/field/giới hạn. Giao thức, kiểu, quyền, thanh ghi D và hệ số KHÔNG đoán:
            // để trống (Address = -1, Scale = 0) và admin khai báo ở trang Thiết bị trước khi chạy.
            var pack = new List<PackMap>();
            if (_cfg.Pack.Count > 0 && _cfg.Pack.All(p => p.Address >= 0))
            {
                // Đã tự khai báo đầy đủ trước khi đăng ký (ghép cặp): giữ nguyên giao thức/thanh ghi/khoá MQTT, chỉ nhận site/MQTT từ server.
                _log.Add("INFO", "enroll", $"giữ {_cfg.Pack.Count} field đã khai báo; site={kit.Site} device={kit.Device}");
                _cfg.Mobile = MobileAccess.Control;
                await ApplyAsync($"Đã đăng ký: {_cfg.Site}/{_cfg.Device} — giữ nguyên {_cfg.Pack.Count} field đã khai báo, gateway publish config lên cloud");
                return (true, $"Đã đăng ký {_cfg.Site}/{_cfg.Device}; giữ nguyên {_cfg.Pack.Count} field đã khai báo.");
            }
            foreach (var c in kit.Pack ?? new())
                foreach (var f in c.Fields ?? new())
                {
                    var lim = c.Limits != null && c.Limits.TryGetValue(f, out var l) ? l : null;
                    pack.Add(new PackMap { Child = c.Id ?? "", Field = f, Address = -1, Scale = 0, Min = lim?.Min, Max = lim?.Max });
                }
            _cfg.Pack = pack; _cfg.Mobile = MobileAccess.Control;
            _log.Add("INFO", "enroll", $"site={_cfg.Site} device={_cfg.Device} cloud={_cfg.CloudHost}:{_cfg.CloudPort} user={_cfg.CloudUser} pack={pack.Count} field");
            await ApplyAsync($"Enroll xong: {_cfg.Site}/{_cfg.Device}, {pack.Count} field — khai báo giao thức/thanh ghi ở trang Thiết bị của Admin");
            return (true, $"Enroll xong: {_cfg.Site}/{_cfg.Device}, {pack.Count} field. Khai báo giao thức/thanh ghi ở trang Thiết bị.");
        }
        catch (Exception ex) { return Done(false, "Enroll lỗi: " + ex.Message); }
    }

    /// <summary>Danh sách giải pháp server cho phép gateway chọn (JSON {solutions:[{id,title}]}).</summary>
    async Task<(bool Ok, string Msg)> SolutionsAsync(string api)
    {
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(api.Trim()), Timeout = TimeSpan.FromSeconds(10) };
            return (true, await http.GetStringAsync("/api/v1/gateway/solutions"));
        }
        catch (Exception ex) { return (false, "Không lấy được danh sách giải pháp: " + ex.Message); }
    }

    /// <summary>GATEWAY chọn giải pháp (đúng một loại UI cho gateway này): lưu, publish config kèm solution lên server, rồi lấy giao diện mới.</summary>
    async Task<(bool Ok, string Msg)> SetSolutionAsync(string api, string id)
    {
        id = (id ?? "").Trim();
        if (id.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z][a-z0-9_]{0,23}$")) return Done(false, "Mã giải pháp không hợp lệ.");
        _cfg.Solution = id;
        await ApplyAsync(id.Length > 0 ? $"Đã chọn giải pháp \"{id}\" cho gateway này" : "Gateway dùng giao diện cơ bản");
        if (_cfg.GatewayQr.Length > 0 && _cfg.CloudApiUrl.Length > 0)
        {
            try
            {
                using var http = new HttpClient { BaseAddress = new Uri(_cfg.CloudApiUrl), Timeout = TimeSpan.FromSeconds(15) };
                var kit = await RefreshKitAsync(http, _cfg.Solution);   // báo giải pháp qua HTTPS có chữ ký rồi nhận giao diện
                if (kit != null) ApplySkin(kit);
                // Server không nhận lựa chọn (vd. tem không xác thực được) → nói rõ thay vì im lặng giữ giao diện cũ
                if (kit != null && (kit.Solution ?? "") != id) return Done(false, $"Server chưa nhận giải pháp \"{id}\" cho gateway này (đang là \"{(string.IsNullOrEmpty(kit.Solution) ? "cơ bản" : kit.Solution)}\").");
            }
            catch (Exception ex) { return Done(false, "Đã lưu trên máy nhưng chưa đồng bộ được giao diện từ server: " + ex.Message); }
        }
        return (true, id.Length > 0 ? $"Gateway này dùng giải pháp \"{id}\"." : "Gateway này dùng giao diện cơ bản.");
    }

    /// <summary>Giao diện của giải pháp (kit.Solution + kit.Ui) → lưu cache; có thay đổi thì báo (áp dụng khi mở lại gateway).</summary>
    /// <summary>Đổi giải pháp (giao diện) xong là ÁP DỤNG NGAY: dựng lại cửa sổ trong cùng tiến trình với bảng màu/trang mới (xem Program.Main). Giữ trạng thái OTP.</summary>
    internal static bool RestartRequested;
    static (LoginResult? Login, DateTime At, string Toast) _carry;

    void ApplySkin(GatewayProvisionKit kit)
    {
        // MỘT gateway = MỘT loại UI, do GATEWAY chọn (mặc định cơ bản): giao diện server gửi khác lựa chọn trên máy thì bỏ qua
        if ((kit.Solution ?? "") != (_cfg.Solution ?? "")) return;
        var (changed, title) = SkinStore.Save(kit.Solution, kit.Ui);
        if (!changed) return;
        _log.Add("INFO", "ui", title.Length > 0 ? $"giao diện giải pháp \"{title}\" đã nhận từ server" : "gateway về giao diện cơ bản");
        var msg = title.Length > 0 ? $"Đã áp dụng giao diện \"{title}\"" : "Đã về giao diện cơ bản";
        if (_testMode) { Toast(msg + " (áp dụng khi mở lại)"); return; }   // chế độ kiểm thử không dựng lại cửa sổ
        Toast(msg);
        // trễ ngắn để thao tác đang chạy (lưu cấu hình, báo kết quả) xong rồi mới dựng lại cửa sổ
        _ = Task.Delay(400).ContinueWith(_ => { if (!IsDisposed) BeginInvoke(async () => { await StopAsync(); _carry = (_login, _loginAt, msg); _carryLocal = _localUnlocked; RestartRequested = true; Close(); }); });   // dừng host trước để cửa sổ mới không tranh cổng/ID MQTT
    }

    /// <summary>
    /// Đồng bộ cấu hình từ server; QR trên máy đã cũ (tem được cấp lại QR) → TỰ lấy QR mới bằng khoá riêng của máy, lưu lại rồi thử lại một lần.
    /// </summary>
    async Task<GatewayProvisionKit?> RefreshKitAsync(HttpClient http, string? solution = null)
    {
        var client = new GatewayEnrollClient(http);
        try { return await client.RefreshConfigAsync(_cfg.GatewayQr, Identity(), false, default, solution); }
        catch (Exception ex) when (GatewayEnrollClient.IsStaleQr(ex))
        {
            var sd = GatewayIdentity.SiteDeviceOfQr(_cfg.GatewayQr);
            var site = sd?.Site ?? _cfg.Site; var device = sd?.Device ?? _cfg.Device;
            string qr;
            try { qr = await client.RefreshQrAsync(site, device, Identity()); }
            catch (Exception e2) { _log.Add("WARN", "cloud", $"QR trên máy đã cũ và không lấy lại được ({e2.Message})"); throw new InvalidOperationException("QR của gateway đã cũ và server không cấp lại được (" + e2.Message + ")."); }
            _cfg.GatewayQr = qr;
            try { SaveCfg(); } catch (IOException) { }
            _qrIcon.Update();
            _log.Add("INFO", "cloud", $"QR của tem {site}/{device} đã được cấp lại trên server — gateway tự cập nhật QR mới");
            Toast("Đã tự cập nhật mã QR mới của gateway từ server.");
            return await client.RefreshConfigAsync(_cfg.GatewayQr, Identity(), false, default, solution);
        }
    }

    // ------------------------------------------------------------------ chờ user: hỏi server tem đã claim chưa
    DateTime _nextClaimPoll = DateTime.MinValue;
    bool _polling;
    async void PollClaimed()
    {
        if (_polling || DateTime.UtcNow < _nextClaimPoll || _cfg.GatewayQr.Length == 0 || _cfg.CloudApiUrl.Length == 0) return;
        _polling = true; _nextClaimPoll = DateTime.UtcNow.AddSeconds(_cfg.CloudSendData ? 300 : 60);   // chưa có user: hỏi dày; đã có: chỉ để nhận tín hiệu unclaimed bị lỡ
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(_cfg.CloudApiUrl), Timeout = TimeSpan.FromSeconds(10) };
            var kit = await RefreshKitAsync(http);
            if (kit != null) ApplySkin(kit);
            if (!string.IsNullOrEmpty(kit?.CmdKey) && kit!.CmdKey != _cfg.CloudCmdKey) { _cfg.CloudCmdKey = kit.CmdKey; try { SaveCfg(); } catch (IOException) { } }   // server đổi khoá ký: nhận qua HTTPS có chữ ký
            if (kit?.Claimed is bool cl && cl != _cfg.CloudSendData)
            {
                _cfg.CloudSendData = cl;
                _log.Add("INFO", "cloud", cl ? "tem đã có user — bắt đầu gửi data" : "tem không còn user — ngừng gửi data");
                try { SaveCfg(); } catch (IOException) { }
            }
        }
        catch (Exception) { /* mất mạng: thử lại sau */ }
        finally { _polling = false; }
    }

    // ------------------------------------------------------------------ nhịp giao diện
    void Tick()
    {
        if (IsDisposed || Disposing) return;   // cửa sổ cũ đã đóng (dựng lại khi đổi UI)
        PollClaimed();
        _log.Flush();
        var running = _host != null;
        var st = running ? _host!.Core.State.Status : "đã dừng";
        _chipPlc.Caption = running ? $"PLC: {st}" : "Gateway: dừng";
        _chipPlc.Dot = !running ? Theme.Muted : st == "online" ? Theme.Green : Theme.Yellow;
        var cs = running ? _host!.Cloud : CloudState.Disabled;
        _chipCloud.Caption = cs switch { CloudState.Connected => "Cloud: đã nối", CloudState.Connecting => "Cloud: đang nối", CloudState.Disconnected => "Cloud: mất kết nối", _ => "Cloud: tắt" };
        _chipCloud.Dot = cs switch { CloudState.Connected => Theme.Green, CloudState.Connecting => Theme.Yellow, CloudState.Disconnected => Theme.Red, _ => Theme.Muted };
        var offline = _cfg.Mobile == MobileAccess.Off || cs != CloudState.Connected;
        if (Unlocked && !_testMode && !_noAuth && !_prompting && AutoLock.Expired())
        {
            LockNow($"Đã tự khoá sau {AutoLock.Minutes} phút không thao tác. Gateway vẫn chạy nền.");
        }
        SyncLockScreen();
        var lockCap = Unlocked ? "🔓 Khoá lại" : "🔒 Mở khoá";
        if (_lockBtn.Caption != lockCap) { _lockBtn.Caption = lockCap; _lockBtn.Primary = !Unlocked; _lockBtn.Invalidate(); }
        _chipMode.Caption = offline ? "Chế độ cục bộ (offline)" : "Có cloud";
        _chipMode.Dot = offline ? Theme.Teal : Theme.Accent;
        _qrIcon.Update();
        LayoutHead();
        if (_current == _dash) _dash.Tick();
        else if (_current == _devices) _devices.Tick();
    }

    // ------------------------------------------------------------------ chụp ảnh các trang (kiểm tra giao diện)
    public async Task ScreenshotsAsync(string dir)
    {
        Directory.CreateDirectory(dir);
        WindowState = FormWindowState.Normal; Size = new Size(1400, 860);
        await Task.Delay(9000);
        // thử đường điều khiển thật: đặt tốc độ bơm 80% rồi đọc lại telemetry
        var wr = await WriteAsync("pump1", "speed", 80);
        var bad = await WriteAsync("pump1", "speed", 500);          // ngoài khoảng Min–Max của Pack → phải bị từ chối
        await Task.Delay(3500);
        TryValue("pump1.speed", out var sp); TryValue("pump1.flow", out var fl);
        File.WriteAllText(Path.Combine(dir, "write-test.txt"), $"write80={wr ?? "ok"} write500={bad ?? "ok"} speed={sp} flow={fl}");
        // chụp thử thẻ QR của trang Cloud: GW_DEMO_QR = chuỗi QR tem (chỉ để kiểm tra giao diện)
        if (Environment.GetEnvironmentVariable("GW_DEMO_QR") is { Length: > 0 } demoQr)
        {
            _cfg.GatewayQr = demoQr; _cfg.Site = "e2etest"; _cfg.Device = "gw01";
            foreach (var p in _pages) (p.Page as CloudPage)?.Refresh2();
        }
        var names = new[] { "dashboard", "devices", "protocols", "cloud", "log" };
        for (var i = 0; i < _pages.Count; i++)
        {
            var shotName = SolutionHost.ExtraPage != null && i >= 1 ? (i == 1 ? SolutionHost.Name : names[i - 1]) : names[i];
            Show(_pages[i].Page); Tick();
            await Task.Delay(1200);
            using var bmp = new Bitmap(Width, Height);
            DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));   // không chụp màn hình: chạy đúng cả khi máy scale DPI
            bmp.Save(Path.Combine(dir, shotName + ".png"));
        }
        foreach (var (name, edit) in new[] { ("dialog-add", (string?)null), ("dialog-edit", _cfg.Pack.FirstOrDefault()?.Child) })
        {
            if (name == "dialog-edit" && edit == null) continue;
            using var dlg = DeviceDialog.Preview(this, edit);
            dlg.Show(this); await Task.Delay(800);
            using var bmp = new Bitmap(dlg.Width, dlg.Height);
            dlg.DrawToBitmap(bmp, new Rectangle(0, 0, dlg.Width, dlg.Height));
            bmp.Save(Path.Combine(dir, name + ".png"));
            dlg.Close();
        }
        Close();
    }
}
