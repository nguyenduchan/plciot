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
    /// <summary>--customer: bản của khách — chỉ giám sát và điều khiển; thiết lập do tool admin gửi qua IP (xem MainForm.Remote.cs).</summary>
    readonly bool _customer = Environment.GetCommandLineArgs().Contains("--customer");
    /// <summary>Gateway KHÔNG sửa thiết bị/giao thức: mọi thiết lập chỉ làm qua tool Admin. Chỉ các chế độ kiểm thử/trình diễn mới mở lại giao diện sửa.</summary>
    readonly bool _editUi = new[] { "--selftest", "--pairtest", "--autodemo", "--shot", "--edittest" }.Any(Environment.GetCommandLineArgs().Contains);

    readonly Panel _side = new() { Dock = DockStyle.Left, Width = 210, BackColor = Theme.Side };
    readonly Panel _head = new() { Dock = DockStyle.Top, Height = 62, BackColor = Theme.Bg };
    readonly Panel _body = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg };
    readonly Label _pageTitle = new() { ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(22, 12), BackColor = Color.Transparent };
    readonly StatusChip _chipPlc = new(), _chipCloud = new(), _chipMode = new();
    readonly FlatButton _demoBtn = new() { Caption = "Demo: tắt", Width = 110 };
    readonly Label _toast = new() { AutoSize = false, Height = 40, Visible = false, ForeColor = Color.White, BackColor = Theme.Accent, Font = Theme.Semi, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0) };
    readonly System.Windows.Forms.Timer _ui = new() { Interval = 500 };
    readonly System.Windows.Forms.Timer _toastTimer = new() { Interval = 4000 };

    readonly DashboardPage _dash;
    readonly DevicesPage _devices;
    readonly ProtocolsPage _protos;
    readonly AdminAccessPage _access = new() { Dock = DockStyle.Fill };
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
        if (_host != null) { await StopAsync(); await StartAsync(); }
        Toast(why);
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
        _protos = new ProtocolsPage(this) { Dock = DockStyle.Fill };
        _log.Dock = DockStyle.Fill;

        // thanh bên
        var logo = new Label { Text = "Gateway", ForeColor = Theme.Text, Font = new Font("Segoe UI Semibold", 17f), AutoSize = false, Dock = DockStyle.Top, Height = 62, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(20, 0, 0, 0), BackColor = Theme.Side };
        var sub = new Label { Text = _customer ? "PLCIOT · BẢN KHÁCH" : "PLCIOT · BẢN ĐẦY ĐỦ", ForeColor = Theme.Muted, Font = new Font("Segoe UI", 7.5f), AutoSize = false, Dock = DockStyle.Top, Height = 20, Padding = new Padding(22, 0, 0, 0), BackColor = Theme.Side };
        var items = new (string Icon, string Name, Control Page)[]
        {
            ("▦", "Tổng quan", _dash), ("⚙", "Thiết bị", _devices), ("⇄", "Giao thức", _protos), ("☰", "Nhật ký", _log), ("⇆", "Kết nối admin", _access),
        };
        if (!_editUi) items = items.Where(x => x.Page != _devices && x.Page != _protos).ToArray();                    // không sửa thiết bị/giao thức tại gateway
        if (_customer) items = items.Where(x => x.Page == _dash || x.Page == _log || x.Page == _access).ToArray();   // khách không thấy trang thiết lập
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
        _qrIcon = new QrIcon(this, () => CloudPage.DefaultServer);
        foreach (var c in new Control[] { _qrIcon, _demoBtn, _chipMode, _chipCloud, _chipPlc }) _head.Controls.Add(c);
        _head.Resize += (_, _) => LayoutHead();
        _demoBtn.Click += async (_, _) => await ToggleDemoAsync();

        Controls.Add(_body); Controls.Add(_head); Controls.Add(_side); Controls.Add(_toast);
        Resize += (_, _) => PlaceToast();
        _toastTimer.Tick += (_, _) => { _toast.Visible = false; _toastTimer.Stop(); };
        _qrIcon.Update();
        LayoutHead();
        Show(_dash);
        _dash.Rebuild();

        _ui.Tick += (_, _) => Tick();
        _ui.Start();
        FormClosing += async (_, _) => { try { SaveCfg(); } catch (IOException) { } await StopAsync(); };
        var args = Environment.GetCommandLineArgs();
        _demo = args.Contains("--demo");
        UpdateDemoButton();
        if (_customer || !_editUi) _demoBtn.Visible = false;
        // luôn tự chạy (kể cả chưa có thiết bị): thêm thiết bị là đọc ngay. Các chế độ kiểm thử tự điều khiển việc chạy.
        if (!args.Contains("--selftest") && !args.Contains("--edittest") && !args.Contains("--pairtest") && !args.Contains("--autodemo")) Shown += async (_, _) => await StartAsync();
        Shown += (_, _) => InitRemoteAccess(args);
        FormClosed += (_, _) => _api?.Dispose();
    }

    QrIcon _qrIcon = null!;

    void LayoutHead()
    {
        var x = _head.Width - 18;
        foreach (var c in new Control[] { _qrIcon, _demoBtn, _chipMode, _chipCloud, _chipPlc })
        {
            if ((_customer || !_editUi) && c == _demoBtn) continue;
            if (c == _qrIcon && !c.Visible) continue;
            x -= c.Width + 8; c.Location = new Point(x, c is StatusChip ? 17 : c == _qrIcon ? 11 : 14);
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

    public Task<(bool Ok, string Msg)> CloudAsync(string action, string api, string value) => action switch
    {
        "pair" => PairAsync(api, value),
        "enroll" => EnrollAsync(api, value),
        _ => Task.FromResult((false, "việc cloud không hợp lệ")),
    };

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

    /// <summary>Nhập mã ghép cặp: gửi khoá công khai + bản khai. Mã tự duyệt → nhận luôn site/MQTT và tự cấu hình + đồng bộ; mã duyệt tay → chờ admin.</summary>
    async Task<(bool Ok, string Msg)> PairAsync(string api, string code)
    {
        code = code.Trim();
        if (code.Length == 0) return Done(false, "Nhập mã ghép cặp do admin phát.");
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(api.Trim()), Timeout = TimeSpan.FromSeconds(30) };
            var json = ConfigBuilder.Build(_cfg, new MetaDescriber(_meta, _cfg));   // đúng bản tin config sẽ publish sau khi đăng ký
            var r = await new GatewayEnrollClient(http).PairAsync(code, Fingerprint.Of(_cfg), json, Identity());
            if (r.Approved && r.Kit != null && r.Qr != null)
            {
                _log.Add("INFO", "pair", $"tự duyệt: {r.Site}/{r.Device}, ID máy {Identity().Hw}");
                return await ApplyKitAsync(r.Kit, r.Qr, api);
            }
            _log.Add("INFO", "pair", $"đã gửi bản khai {r.Devices} thiết bị ({json.Length} byte), vân tay {Fingerprint.Of(_cfg)}, ID máy {Identity().Hw} — chờ admin duyệt");
            return Done(true, $"Đã gửi bản khai cho admin (vân tay {Fingerprint.Of(_cfg)}). Chờ admin duyệt rồi dán QR vào ô QR để Enroll.");
        }
        catch (Exception ex) { return Done(false, ex.Message switch { "invalid_pairing" => "Mã ghép cặp sai, hết hạn hoặc đã dùng.", "invalid_proof" => "Đồng hồ máy lệch quá 5 phút so với server — chỉnh lại giờ rồi thử lại.", _ => "Ghép cặp lỗi: " + ex.Message }); }
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
            _cfg.GatewayQr = qr; _cfg.CloudApiUrl = api.Trim();
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
            var kit = await new GatewayEnrollClient(http).RefreshConfigAsync(_cfg.GatewayQr, Identity());
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
        var names = new[] { "dashboard", "devices", "protocols", "log", "admin" };
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
