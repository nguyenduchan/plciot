using System.Collections.Concurrent;
using System.Text.Json;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Cửa sổ thiết lập MỘT gateway khác qua mạng LAN (gateway MCU Waveshare ESP32-S3 hoặc gateway PC bật "Kết nối admin").
/// Dùng lại NGUYÊN các trang Tổng quan / Thiết bị / Cloud / Nhật ký của GatewayApp — chỉ khác nơi lưu: cấu hình được đẩy xuống
/// thiết bị (PUT /api/config) thay vì ghi vào máy này. Gateway trên PC này vẫn chạy bình thường trong lúc thiết lập thiết bị khác.
/// </summary>
public sealed class RemoteForm : Form, IGatewayApp
{
    /// <summary>API không gửi mật khẩu MQTT về: thiết bị đã đăng ký thì giữ dấu này trong bộ nhớ (trang Cloud hiện "đã đăng ký"), không bao giờ gửi đi.</summary>
    const string KeepSecret = "\u0001keep";
    static readonly JsonSerializerOptions J = new() { PropertyNameCaseInsensitive = true };

    RemoteClient _client;
    readonly ApiHello _hello;
    readonly string _host;
    readonly int _port;
    readonly ScadaConfig _cfg = new();
    readonly UiMetaStore _meta = new(Path.Combine(Path.GetTempPath(), "gw-remote.json")) { Persist = false };   // metadata là của thiết bị: chỉ giữ trong bộ nhớ
    readonly HistoryStore _history = new();
    readonly ConcurrentDictionary<string, double> _values = new();
    ApiState _state = new();
    int _rev = -1, _fails;
    bool _polling, _busy, _lost, _reconnecting;

    readonly Panel _side = new() { Dock = DockStyle.Left, Width = 210, BackColor = Theme.Side };
    readonly Panel _head = new() { Dock = DockStyle.Top, Height = 62, BackColor = Theme.Bg };
    readonly Panel _body = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg };
    readonly Label _pageTitle = new() { ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(22, 12), BackColor = Color.Transparent, UseMnemonic = false };
    readonly StatusChip _chipLink = new(), _chipPlc = new(), _chipCloud = new();
    readonly FlatButton _closeBtn = new() { Caption = "Ngắt kết nối", Width = 130 };
    /// <summary>Đổi IP của board (chỉ hiện khi thiết bị có API /api/network — board MCU; gateway PC không có).</summary>
    readonly FlatButton _netBtn = new() { Caption = "Mạng (IP)…", Width = 120, Visible = false };
    /// <summary>PC quản trị của board (đồng ý / từ chối PC đang chờ ghép) — chỉ board MCU.</summary>
    readonly FlatButton _adminBtn = new() { Caption = "PC quản trị…", Width = 130, Visible = false };
    readonly Label _toast = new() { AutoSize = false, Height = 40, Visible = false, ForeColor = Color.White, BackColor = Theme.Accent, Font = Theme.Semi, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0) };
    readonly System.Windows.Forms.Timer _ui = new() { Interval = 1000 };
    readonly System.Windows.Forms.Timer _toastTimer = new() { Interval = 4000 };
    readonly DashboardPage _dash;
    readonly DevicesPage _devices;
    readonly CloudPage _cloud;
    readonly LogPage _log = new() { Dock = DockStyle.Fill };
    readonly List<(NavButton Btn, Control Page, string Title)> _pages = new();
    Control _current = null!;

    string KindName => _hello.Kind == "mcu" ? "Waveshare" : "Gateway PC";

    RemoteForm(RemoteClient client, ApiHello hello, string host, int port, ApiConfig first)
    {
        _client = client; _hello = hello; _host = host; _port = port;
        LoadFrom(first);
        Text = $"Thiết lập {KindName} — {client.Address}" + (hello.Name.Length > 0 ? $" ({hello.Name})" : "");
        Width = 1400; Height = 860; MinimumSize = new Size(1100, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; DoubleBuffered = true;

        _dash = new DashboardPage(this) { Dock = DockStyle.Fill };
        _devices = new DevicesPage(this) { Dock = DockStyle.Fill };
        _cloud = new CloudPage(this) { Dock = DockStyle.Fill };

        var brand = new Brand { Title = KindName, IconId = "grid", Sub = "QUA LAN · " + client.Address };
        foreach (var (icon, name, page) in new (string, string, Control)[] { ("grid", "Tổng quan", _dash), ("device", "Thiết bị", _devices), ("cloud", "Cloud", _cloud), ("list", "Nhật ký", _log) })
        {
            var b = new NavButton { Icon = icon, Caption = name };
            var p = page;
            b.Click += (_, _) => Show(p);
            _pages.Add((b, page, name)); page.Visible = false; _body.Controls.Add(page);
        }
        for (var i = _pages.Count - 1; i >= 0; i--) _side.Controls.Add(_pages[i].Btn);
        _side.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Side });
        _side.Controls.Add(brand);
        _side.Controls.Add(new Label { Text = "Đang thiết lập thiết bị qua mạng — không phải gateway trên PC này", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Bottom, Height = 48, Padding = new Padding(20, 0, 8, 0), TextAlign = ContentAlignment.MiddleLeft, BackColor = Theme.Side });

        _head.Controls.Add(_pageTitle);
        foreach (var c in new Control[] { _closeBtn, _netBtn, _adminBtn, _chipCloud, _chipPlc, _chipLink }) _head.Controls.Add(c);
        _closeBtn.Click += (_, _) => Close();
        _netBtn.Click += async (_, _) => { if (RequireEdit()) await ChangeNetworkAsync(); };
        _adminBtn.Click += (_, _) => { if (RequireEdit()) AdminsDialog.Run(this, _client); };
        Shown += async (_, _) => { try { await _client.NetworkAsync(); _netBtn.Visible = true; _adminBtn.Visible = _client.Tls; LayoutHead(); } catch (Exception) { /* gateway PC: không có API mạng */ } };
        _head.Resize += (_, _) => LayoutHead();

        Controls.Add(_body); Controls.Add(_head); Controls.Add(_side); Controls.Add(_toast);
        Resize += (_, _) => PlaceToast();
        _toastTimer.Tick += (_, _) => { _toast.Visible = false; _toastTimer.Stop(); };
        LayoutHead();
        Show(_dash);
        _dash.Rebuild();
        Log("INFO", "lan", $"đã nối {KindName} {client.Address}" + (hello.Hw.Length > 0 ? $" · mã phần cứng {hello.Hw}" : "") + (hello.Version.Length > 0 ? $" · phiên bản {hello.Version}" : ""));
        _ui.Tick += async (_, _) => await PollAsync();
        _ui.Start();
        Shown += async (_, _) => await PollAsync();
        Shown += (_, _) => { if (PendingNote is { } n) { PendingNote = null; Toast(n); Log("INFO", "lan", n); } };
        FormClosed += (_, _) => { _ui.Stop(); _toastTimer.Stop(); _ui.Dispose(); _toastTimer.Dispose(); _client.Dispose(); };
    }

    /// <summary>Kiểm thử (--lantest): mở cửa sổ với phiên đã nối sẵn, không qua hộp thoại.</summary>
    internal static RemoteForm ForTest(RemoteClient c, ApiHello h, string host, int port, ApiConfig first) => new(c, h, host, port, first);
    internal void ShowPage(int i) => Show(_pages[i].Page);
    internal string LogText => string.Join(Environment.NewLine, _logLines);
    readonly List<string> _logLines = new();
    void Log(string dir, string ch, string text) { _log.Add(dir, ch, text); lock (_logLines) _logLines.Add($"{dir} {ch} {text}"); }

    /// <summary>Hỏi IP + mã kết nối rồi mở cửa sổ thiết lập thiết bị đó. Gọi từ gateway PC (nút "Kết nối Waveshare (LAN)").</summary>
    public static void Open(IWin32Window owner, string host = "", int port = 80, string code = "", string? note = null)
    {
        var r = ConnectDialog.Run(owner, host, port, code, note);
        if (r == null) return;
        new RemoteForm(r.Value.Client, r.Value.Hello, r.Value.Host, r.Value.Port, r.Value.Config).Show();
    }

    // ------------------------------------------------------------------ đồng bộ với thiết bị
    void LoadFrom(ApiConfig c)
    {
        var s = c.Config ?? new ScadaConfig();
        if (s.MqttId.Length > 0 && string.IsNullOrEmpty(s.CloudPassword)) s.CloudPassword = KeepSecret;
        foreach (var p in typeof(ScadaConfig).GetProperties().Where(p => p.CanWrite && p.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), true).Length == 0))
            p.SetValue(_cfg, p.GetValue(s));
        _meta.Replace(c.Fields ?? new(), c.Devices ?? new());
    }

    /// <summary>Bản gửi đi: bỏ dấu giữ mật khẩu (thiết bị hiểu rỗng = giữ mật khẩu cũ).</summary>
    ApiConfig Outgoing()
    {
        var clone = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(_cfg))!;
        if (clone.CloudPassword == KeepSecret) clone.CloudPassword = "";
        return new ApiConfig { Config = clone, Fields = new(_meta.Map), Devices = new(_meta.Devices) };
    }

    async Task ReloadAsync()
    {
        var c = await _client.ConfigAsync();
        LoadFrom(c);
        _dash.Rebuild(); _cloud.Refresh2();
    }

    /// <summary>Đang mở hộp thoại (thêm/sửa thiết bị…): không nạp lại cấu hình dưới chân người đang sửa.</summary>
    bool Editing => OwnedForms.Length > 0 || (ActiveForm is { Modal: true } f && f != this);

    async Task PollAsync()
    {
        if (_polling || IsDisposed) return;
        _polling = true;
        try
        {
            ApiState st;
            try { st = await _client.StateAsync(); }
            catch (RemoteException e) when (e.Code == "unauthorized") { await ReconnectAsync(); return; }
            catch (Exception e)
            {
                if (++_fails == 3) { _lost = true; Log("WARN", "lan", "mất kết nối thiết bị: " + RemoteClient.Explain(e)); Toast("Mất kết nối tới thiết bị — đang thử lại…", true); }
                return;
            }
            if (_lost) { Log("INFO", "lan", "đã nối lại thiết bị"); Toast("Đã nối lại thiết bị."); }
            _fails = 0; _lost = false;
            _state = st;
            foreach (var kv in st.Values) { _values[kv.Key] = kv.Value; _history.Add(kv.Key, kv.Value); }
            foreach (var k in _values.Keys.Except(st.Values.Keys).ToList()) _values.TryRemove(k, out _);
            if (st.Rev != _rev && !_busy && !Editing)
            {
                if (_rev >= 0) Log("INFO", "lan", $"cấu hình trên thiết bị đã đổi (rev {st.Rev}) — nạp lại");
                _rev = st.Rev;
                try { await ReloadAsync(); } catch (Exception e) { Log("WARN", "lan", "nạp cấu hình lỗi: " + RemoteClient.Explain(e)); }
            }
        }
        finally { _polling = false; Tick(); }
    }

    /// <summary>Thiết bị khởi động lại (mất phiên). Board MCU: tự đăng nhập lại bằng khoá PC (đã ghép, không hỏi gì). Gateway PC: hỏi mã mới.</summary>
    async Task ReconnectAsync()
    {
        if (_reconnecting) return;
        _reconnecting = true; _ui.Stop();
        try
        {
            if (_client.Tls && IdentityProvider != null)
            {
                for (var i = 0; i < 3; i++)
                {
                    try
                    {
                        var (c, _) = await RemoteClient.ConnectMcuAsync(_host, _port, IdentityProvider(), _ => false);   // board đã ghim: board lạ → từ chối
                        _client.Dispose(); _client = c; _rev = -1;
                        LoadFrom(await c.ConfigAsync()); _dash.Rebuild(); _cloud.Refresh2();
                        Log("INFO", "lan", "đã tự đăng nhập lại board bằng khoá PC");
                        return;
                    }
                    catch (Exception e) { Log("WARN", "lan", "đăng nhập lại: " + RemoteClient.Explain(e)); await Task.Delay(2000); }
                }
            }
            Log("WARN", "lan", "phiên hết hiệu lực (thiết bị khởi động lại?) — kết nối lại");
            var r = ConnectDialog.Run(this, _host, _port, "", "Phiên kết nối đã hết (thiết bị vừa khởi động lại). Bấm Kết nối để nối lại.");
            if (r == null) { Close(); return; }
            _client.Dispose(); _client = r.Value.Client; _rev = -1;
            LoadFrom(r.Value.Config); _dash.Rebuild(); _cloud.Refresh2();
            await Task.CompletedTask;
        }
        finally { _reconnecting = false; if (!IsDisposed) _ui.Start(); }
    }

    // ------------------------------------------------------------------ IGatewayApp
    public ScadaConfig Config => _cfg;
    public UiMetaStore Meta => _meta;
    public HistoryStore History => _history;
    public bool Running => _state.Running;
    public bool TryValue(string key, out double v) => _values.TryGetValue(key, out v);
    public string FingerprintText => _state.Fingerprint;
    public string HwText => _hello.Hw;
    /// <summary>Sửa cấu hình thiết bị qua LAN dùng CHUNG phiên sửa 5 phút + mật khẩu của GatewayApp trên PC này (EditGate do MainForm đặt).</summary>
    public bool RequireEdit() => EditGate?.Invoke() ?? true;

    /// <summary>Khoá riêng của PC này (GatewayIdentity của GatewayApp) — board MCU ghép/đăng nhập bằng khoá này, không mã.</summary>
    internal static Func<Plciot.Scada.Services.Ui.GatewayIdentity>? IdentityProvider { get; set; }
    /// <summary>Cổng mật khẩu GatewayApp (RequireEdit của MainForm): người ngồi vào PC đã ghép mà không biết mật khẩu thì không sửa được board.</summary>
    internal static Func<bool>? EditGate { get; set; }
    /// <summary>Thông báo hiện khi cửa sổ mở (vd. "vừa ghép PC này").</summary>
    internal static string? PendingNote { get; set; }

    public async Task<string?> WriteAsync(string child, string field, double value)
    {
        try { var r = await _client.WriteAsync(child, field, value); return r.Ok ? null : r.Err ?? "lỗi"; }
        catch (Exception e) { return RemoteClient.Explain(e); }
    }

    public async Task<string?> SetDeviceEnabledAsync(string child, bool enabled)
    {
        try
        {
            var r = await _client.DeviceAsync(child, enabled);
            if (!r.Ok) return r.Err ?? "lỗi";
            foreach (var p in _cfg.Pack.Where(p => p.Child == child)) p.Enabled = enabled;
            Toast(enabled ? $"Thiết bị {child} đang chạy" : $"Thiết bị {child} đã tạm dừng");
            return null;
        }
        catch (Exception e) { return RemoteClient.Explain(e); }
    }

    /// <summary>Đẩy toàn bộ cấu hình xuống thiết bị; thiết bị kiểm tra, lưu, khởi động lại luồng đọc. Lỗi → nạp lại bản trên thiết bị (giao diện không lệch với thiết bị).</summary>
    public async Task ApplyAsync(string why)
    {
        var err = _cfg.Validate();
        if (err != null) { Toast("Cấu hình chưa hợp lệ: " + err, true); return; }
        _busy = true;
        try
        {
            var r = await _client.PutConfigAsync(Outgoing());
            if (!r.Ok) throw new RemoteException(r.Err ?? "lỗi");
            Log("INFO", "lan", "đã lưu cấu hình xuống thiết bị: " + why);
            Toast(why + " (đã lưu xuống thiết bị)");
        }
        catch (Exception e)
        {
            Log("ERR", "lan", "lưu cấu hình lỗi: " + RemoteClient.Explain(e));
            Toast("Không lưu được xuống thiết bị: " + RemoteClient.Explain(e), true);
        }
        finally
        {
            try { await ReloadAsync(); } catch (Exception) { /* lần đọc trạng thái kế sẽ nạp lại */ }
            _busy = false;
        }
    }

    public void SaveConfig() => _ = ApplyAsync("Đã lưu cài đặt");

    public async Task<(bool Ok, string Msg)> CloudAsync(string action, string api, string value)
    {
        // Thiết bị MCU không có màn hình: người cài đặt đăng nhập webapp NGAY TRÊN MÁY NÀY, thiết bị chỉ nhận phiên (token) để tự đăng ký với server
        if (action == "register")
        {
            using var f = new LoginForm(api, "Đăng nhập webapp", $"Đăng nhập tài khoản webapp để gắn {KindName} {_client.Address} vào tài khoản");
            if (f.ShowDialog(this) != DialogResult.OK || f.Result == null) return (false, "Chưa đăng nhập webapp.");
            value = JsonSerializer.Serialize(f.Result);
        }
        try
        {
            var r = await _client.CloudAsync(action, api, value);
            var msg = r.Msg ?? r.Err ?? (r.Ok ? "Xong." : "Lỗi.");
            Log(r.Ok ? "INFO" : "ERR", "lan", $"cloud {action}: {msg}");
            try { await ReloadAsync(); } catch (Exception) { }
            return (r.Ok, msg);
        }
        catch (Exception e) { return (false, RemoteClient.Explain(e)); }
    }

    /// <summary>Lịch sử SQLite nằm trên thiết bị: chưa xem/xuất được qua LAN.</summary>
    public (long Total, long Unsent, long Oldest) HistoryStats() => (0, 0, 0);
    public Task<long> ExportHistoryAsync(string path, string format, long fromMs, long toMs) => throw new InvalidOperationException("xuất lịch sử của thiết bị qua LAN chưa hỗ trợ — xuất trên webapp");

    public void Toast(string text, bool error = false)
    {
        if (InvokeRequired) { BeginInvoke(() => Toast(text, error)); return; }
        _toast.Text = text; _toast.BackColor = error ? Theme.Red : Theme.Accent; _toast.Visible = true; _toast.BringToFront();
        PlaceToast(); _toastTimer.Stop(); _toastTimer.Start();
    }

    // ------------------------------------------------------------------ giao diện
    void PlaceToast()
    {
        _toast.Size = new Size(Math.Max(240, Math.Min(760, ClientSize.Width - 260)), 40);
        _toast.Location = new Point(_side.Width + 20, ClientSize.Height - 60);
    }

    void LayoutHead()
    {
        var x = _head.Width - 18;
        foreach (var c in new Control[] { _closeBtn, _netBtn, _adminBtn, _chipCloud, _chipPlc, _chipLink })
        {
            if (!c.Visible && (c == _netBtn || c == _adminBtn)) continue;
            x -= c.Width + 8; c.Location = new Point(x, c is StatusChip ? 17 : 14);
        }
    }

    /// <summary>Đổi IP board: lưu xong board khởi động lại → đóng cửa sổ này, mở hộp kết nối điền sẵn IP mới (DHCP: tìm lại trong danh sách).</summary>
    async Task ChangeNetworkAsync()
    {
        var newHost = await NetworkDialog.RunAsync(this, _client);
        if (newHost == null) return;
        Log("INFO", "lan", newHost.Length > 0 ? $"đổi IP board → {newHost}, board khởi động lại" : "board chuyển sang DHCP, khởi động lại");
        _ui.Stop();
        var port = _port; var owner = Owner;
        Hide();
        BeginInvoke(() =>
        {
            Open(owner!, newHost, port, "", newHost.Length > 0
                ? $"Board đang khởi động lại với IP {newHost} (khoảng 5–10 giây; khởi động lại thì cửa sổ cài đặt tự mở lại 10 phút). Nhập mã kết nối để nối lại."
                : "Board đang khởi động lại và xin IP bằng DHCP. Bấm \"Tìm lại\" sau vài giây rồi chọn board trong danh sách.");
            Close();
        });
    }

    void Show(Control page)
    {
        _current = page;
        foreach (var (btn, p, title) in _pages) { var on = p == page; btn.Selected = on; btn.Invalidate(); p.Visible = on; if (on) _pageTitle.Text = title; }
        page.BringToFront();
        Tick();
    }

    void Tick()
    {
        if (IsDisposed || Disposing) return;
        _log.Flush();
        _chipLink.Caption = _lost ? "LAN: mất kết nối" : $"LAN: {_client.Address}";
        _chipLink.Dot = _lost ? Theme.Red : Theme.Green;
        var st = _state.Running ? _state.Status : "đã dừng";
        _chipPlc.Caption = _state.Running ? $"PLC: {st}" : "Gateway: dừng";
        _chipPlc.Dot = !_state.Running ? Theme.Muted : st == "online" ? Theme.Green : Theme.Yellow;
        _chipCloud.Caption = _state.Cloud switch { "Connected" => "Cloud: đã nối", "Connecting" => "Cloud: đang nối", "Disconnected" => "Cloud: mất kết nối", _ => "Cloud: tắt" };
        _chipCloud.Dot = _state.Cloud switch { "Connected" => Theme.Green, "Connecting" => Theme.Yellow, "Disconnected" => Theme.Red, _ => Theme.Muted };
        foreach (var c in new Control[] { _chipLink, _chipPlc, _chipCloud }) c.Invalidate();
        LayoutHead();
        if (_current == _dash) _dash.Tick();
        else if (_current == _devices) _devices.Tick();
    }
}
