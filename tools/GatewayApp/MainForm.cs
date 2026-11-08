using System.Collections.Concurrent;
using System.Text.Json;
using GatewayApp.Ui;
using Plciot.Scada;
using Plciot.Scada.Services.Ui;

namespace GatewayApp;

/// <summary>
/// Gateway C# có giao diện: dashboard tối kiểu Grafana vẽ bằng GDI+ (C# thuần, không web, không CDN → chạy offline).
/// Trang: Tổng quan · Thiết bị (thêm thiết bị ngoại vi) · Giao thức · Cloud (tuỳ chọn) · Nhật ký.
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

    readonly Panel _side = new() { Dock = DockStyle.Left, Width = 210, BackColor = Theme.Side };
    readonly Panel _head = new() { Dock = DockStyle.Top, Height = 62, BackColor = Theme.Bg };
    readonly Panel _body = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg };
    readonly Label _pageTitle = new() { ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(22, 12), BackColor = Color.Transparent };
    readonly StatusChip _chipPlc = new(), _chipCloud = new(), _chipMode = new();
    readonly FlatButton _start = new() { Caption = "▶  Chạy gateway", Primary = true, Width = 160 };
    readonly FlatButton _demoBtn = new() { Caption = "Demo: tắt", Width = 110 };
    readonly Label _toast = new() { AutoSize = false, Height = 40, Visible = false, ForeColor = Color.White, BackColor = Theme.Accent, Font = Theme.Semi, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0) };
    readonly System.Windows.Forms.Timer _ui = new() { Interval = 500 };
    readonly System.Windows.Forms.Timer _toastTimer = new() { Interval = 4000 };

    readonly DashboardPage _dash;
    readonly DevicesPage _devices;
    readonly ProtocolsPage _protos;
    readonly CloudPage _cloud;
    readonly LogPage _log = new();
    readonly List<(NavButton Btn, Control Page, string Title)> _pages = new();
    Control _current = null!;

    static ScadaConfig Defaults() => new()
    {
        Site = "factory1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PollMs = 300,
        Mobile = MobileAccess.Off, LocalBrokerEnabled = false, LocalBind = "0.0.0.0", WebEnabled = false,
        LocalUsers = new() { new LocalUser { User = "gw", Password = "", Role = LocalRole.Device } },
        CloudTelemetryMinMs = 2000,
    };

    static string SettingsPath => Environment.GetEnvironmentVariable("GATEWAYAPP_SETTINGS") is { Length: > 0 } p ? p : ConfigStore.PathFor("gateway-app");

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
        var payload = JsonSerializer.SerializeToUtf8Bytes(new { id = Guid.NewGuid().ToString("N")[..8], child, key = field, v = value });
        string? ack;
        try { ack = await h.Core.ExecuteKeyAsync(payload, ControlSource.LocalScreen, "ui"); }
        catch (Exception e) { return e.Message; }
        if (ack == null) return null;            // chế độ gateway ESP32: ack đến sau
        using var d = JsonDocument.Parse(ack);
        if (d.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True) return null;
        return d.RootElement.TryGetProperty("err", out var e2) ? e2.GetString() : "lỗi";
    }

    public async Task ApplyAsync(string why)
    {
        try { SaveCfg(); } catch (IOException) { /* không quan trọng */ }
        if (_host != null) { await StopAsync(); await StartAsync(); }
        Toast(why + (Running ? "" : " (lưu rồi, bấm Chạy để áp dụng)"));
    }

    public void Toast(string text, bool error = false)
    {
        if (InvokeRequired) { BeginInvoke(() => Toast(text, error)); return; }
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
        Text = "Plciot Gateway — giám sát và điều khiển (offline)";
        Width = 1400; Height = 860; MinimumSize = new Size(1100, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; DoubleBuffered = true;
        _meta = new UiMetaStore(SettingsPath);
        try { if (File.Exists(SettingsPath)) CopyFrom(ConfigStore.Load(SettingsPath)); } catch (Exception e) when (e is IOException or JsonException) { /* dùng mặc định */ }

        _dash = new DashboardPage(this) { Dock = DockStyle.Fill };
        _devices = new DevicesPage(this) { Dock = DockStyle.Fill };
        _protos = new ProtocolsPage(this) { Dock = DockStyle.Fill };
        _cloud = new CloudPage(this) { Dock = DockStyle.Fill };
        _cloud.EnrollRequested = EnrollAsync;
        _log.Dock = DockStyle.Fill;

        // thanh bên
        var logo = new Label { Text = "Plciot", ForeColor = Theme.Text, Font = new Font("Segoe UI Semibold", 17f), AutoSize = false, Dock = DockStyle.Top, Height = 62, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(20, 0, 0, 0), BackColor = Theme.Side };
        var sub = new Label { Text = "GATEWAY · OFFLINE-READY", ForeColor = Theme.Muted, Font = new Font("Segoe UI", 7.5f), AutoSize = false, Dock = DockStyle.Top, Height = 20, Padding = new Padding(22, 0, 0, 0), BackColor = Theme.Side };
        var items = new (string Icon, string Name, Control Page)[]
        {
            ("▦", "Tổng quan", _dash), ("⚙", "Thiết bị", _devices), ("⇄", "Giao thức", _protos), ("☁", "Cloud", _cloud), ("☰", "Nhật ký", _log),
        };
        foreach (var (icon, name, page) in items)
        {
            var b = new NavButton { Icon = icon, Caption = name };
            var p = page; var n = name;
            b.Click += (_, _) => Show(p);
            _pages.Add((b, page, n)); page.Visible = false; _body.Controls.Add(page);
        }
        for (var i = _pages.Count - 1; i >= 0; i--) _side.Controls.Add(_pages[i].Btn);
        _side.Controls.Add(sub); _side.Controls.Add(logo);
        var ver = new Label { Text = "C# thuần · không cần Internet", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Bottom, Height = 34, Padding = new Padding(20, 0, 0, 0), TextAlign = ContentAlignment.MiddleLeft, BackColor = Theme.Side };
        _side.Controls.Add(ver);

        // thanh trên
        _head.Controls.Add(_pageTitle);
        foreach (var c in new Control[] { _start, _demoBtn, _chipMode, _chipCloud, _chipPlc }) _head.Controls.Add(c);
        _head.Resize += (_, _) => LayoutHead();
        _start.Click += async (_, _) => await ToggleAsync();
        _demoBtn.Click += async (_, _) => await ToggleDemoAsync();

        Controls.Add(_body); Controls.Add(_head); Controls.Add(_side); Controls.Add(_toast);
        Resize += (_, _) => PlaceToast();
        _toastTimer.Tick += (_, _) => { _toast.Visible = false; _toastTimer.Stop(); };
        LayoutHead();
        Show(_dash);
        _dash.Rebuild();

        _ui.Tick += (_, _) => Tick();
        _ui.Start();
        FormClosing += async (_, _) => { try { SaveCfg(); } catch (IOException) { } await StopAsync(); };
        var args = Environment.GetCommandLineArgs();
        _demo = args.Contains("--demo");
        UpdateDemoButton();
        if (args.Contains("--autostart") || _demo) Shown += async (_, _) => await StartAsync();
    }

    void LayoutHead()
    {
        var x = _head.Width - 18;
        foreach (var c in new Control[] { _start, _demoBtn, _chipMode, _chipCloud, _chipPlc })
        {
            x -= c.Width + 8; c.Location = new Point(x, c is StatusChip ? 17 : 14);
        }
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

    void CopyFrom(ScadaConfig s)
    {
        foreach (var p in typeof(ScadaConfig).GetProperties().Where(p => p.CanWrite && p.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), true).Length == 0))
            p.SetValue(_cfg, p.GetValue(s));
    }

    // ------------------------------------------------------------------ chạy / dừng
    async Task ToggleAsync() { if (_host != null) await StopAsync(); else await StartAsync(); }

    async Task ToggleDemoAsync()
    {
        _demo = !_demo; UpdateDemoButton();
        _meta.Persist = !_demo;
        if (_demo && _cfg.Pack.Count == 0) DemoDriver.InstallSample(_cfg, _meta);
        else if (!_demo && DemoDriver.IsSample(_cfg)) { _cfg.Pack.Clear(); _meta.Reload(); }   // rời demo: bỏ bộ mẫu tạm, không lưu
        else if (!_demo) _meta.Reload();
        if (_host != null) { await StopAsync(); await StartAsync(); }
        else Toast(_demo ? "Demo bật: bấm Chạy gateway để xem bồn nước + bơm mô phỏng ngay trong chương trình." : "Demo tắt.");
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
            h.Log += l => _log.Add("LOG", "gateway", l);
            h.Core.Traffic += (d, c, t) => _log.Add(d, c, t);
            h.Core.Publish += OnPublish;
            _host = h;
            await h.StartAsync();
        }
        catch (LicenseRequiredException e) { await Abort(); Toast(e.Message, true); return; }
        catch (Exception e) { await Abort(); Toast("Không chạy được: " + e.Message, true); return; }
        _start.Caption = "■  Dừng"; _start.Danger = true; _start.Primary = false; _start.Invalidate();
        Toast(_demo ? "Gateway đang chạy với PLC giả (demo)." : $"Gateway đang chạy: {_cfg.Source} {_cfg.PlcHost}");
    }

    async Task Abort()
    {
        var h = _host; _host = null;
        if (h != null) { try { await h.DisposeAsync(); } catch (Exception) { /* bỏ qua */ } }
    }

    async Task StopAsync()
    {
        await Abort();
        _start.Caption = "▶  Chạy gateway"; _start.Danger = false; _start.Primary = true; _start.Invalidate();
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

    // ------------------------------------------------------------------ enroll từ QR (tuỳ chọn, cần Internet)
    async Task EnrollAsync()
    {
        if (string.IsNullOrWhiteSpace(_cloud.Qr.Text)) { Toast("Dán mã QR của tem vào ô \"Mã QR của tem\".", true); return; }
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(_cloud.Api.Text.Trim()), Timeout = TimeSpan.FromSeconds(15) };
            var kit = await new GatewayEnrollClient(http).EnrollAsync(_cloud.Qr.Text.Trim());
            if (kit == null) throw new InvalidOperationException("server không trả dữ liệu");
            _cfg.Site = kit.Site ?? _cfg.Site; _cfg.Device = kit.Device ?? _cfg.Device;
            if (kit.Mqtt != null)
            {
                _cfg.CloudUser = kit.Mqtt.Username ?? _cfg.CloudUser;
                _cfg.CloudPassword = kit.Mqtt.Password ?? _cfg.CloudPassword;
                if (Uri.TryCreate(kit.Mqtt.Mqtts, UriKind.Absolute, out var u)) { _cfg.CloudHost = u.Host; _cfg.CloudPort = u.Port; _cfg.CloudTransport = "mqtts"; }
            }
            // Pack: mỗi field một thanh ghi D liên tiếp từ D50 (PlcSim dùng cùng quy ước). Boolean-like → hệ số 1, còn lại 10.
            var addr = 50; var pack = new List<PackMap>();
            foreach (var c in kit.Pack ?? new())
                foreach (var f in c.Fields ?? new())
                {
                    var lim = c.Limits != null && c.Limits.TryGetValue(f, out var l) ? l : null;
                    pack.Add(new PackMap { Child = c.Id ?? "", Field = f, Address = addr++, Scale = f is "run" or "on" or "v" ? 1 : 10, Min = lim?.Min, Max = lim?.Max });
                }
            _cfg.Pack = pack; _cfg.Mobile = MobileAccess.Control;
            _log.Add("INFO", "enroll", $"site={_cfg.Site} device={_cfg.Device} cloud={_cfg.CloudHost}:{_cfg.CloudPort} user={_cfg.CloudUser} pack={pack.Count} field");
            await ApplyAsync($"Enroll xong: {_cfg.Site}/{_cfg.Device}, {pack.Count} field");
        }
        catch (Exception ex) { Toast("Enroll lỗi: " + ex.Message, true); }
    }

    // ------------------------------------------------------------------ nhịp giao diện
    void Tick()
    {
        _log.Flush();
        var running = _host != null;
        var st = running ? _host!.Core.State.Status : "đã dừng";
        _chipPlc.Caption = running ? $"PLC: {st}" : "Gateway: dừng";
        _chipPlc.Dot = !running ? Theme.Muted : st == "online" ? Theme.Green : Theme.Yellow;
        var cs = running ? _host!.Cloud : CloudState.Disabled;
        _chipCloud.Caption = cs switch { CloudState.Connected => "Cloud: đã nối", CloudState.Connecting => "Cloud: đang nối", CloudState.Disconnected => "Cloud: mất kết nối", _ => "Cloud: tắt" };
        _chipCloud.Dot = cs switch { CloudState.Connected => Theme.Green, CloudState.Connecting => Theme.Yellow, CloudState.Disconnected => Theme.Red, _ => Theme.Muted };
        var offline = _cfg.Mobile == MobileAccess.Off || cs != CloudState.Connected;
        _chipMode.Caption = offline ? "Chế độ cục bộ (offline)" : "Có cloud";
        _chipMode.Dot = offline ? Theme.Teal : Theme.Accent;
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
        var names = new[] { "dashboard", "devices", "protocols", "cloud", "log" };
        for (var i = 0; i < _pages.Count; i++)
        {
            Show(_pages[i].Page); Tick();
            await Task.Delay(1200);
            using var bmp = new Bitmap(Width, Height);
            DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));   // không chụp màn hình: chạy đúng cả khi máy scale DPI
            bmp.Save(Path.Combine(dir, names[i] + ".png"));
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
