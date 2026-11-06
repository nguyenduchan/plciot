using System.Text.Json;
using Plciot.Scada;
using Plciot.Scada.Services.Ui;

namespace GatewayApp;

/// <summary>
/// Gateway C# có giao diện. Cấu hình qua PropertyGrid (toàn bộ ScadaConfig: nguồn PLC/giao thức, cloud, Pack…),
/// QR tem → enroll lấy MQTT + pack từ server, và bảng traffic hiển thị mọi dữ liệu đi/đến:
/// PLC→GW, GW→PLC, GW→Cloud, Cloud→GW (webapp điều khiển).
/// </summary>
public sealed class MainForm : Form
{
    readonly ScadaConfig _cfg = Defaults();
    readonly PropertyGrid _grid = new() { Dock = DockStyle.Fill, SelectedObject = null };
    readonly TextBox _qr = new() { Dock = DockStyle.Fill };
    readonly TextBox _api = new() { Text = "https://plc.dieukhientudong.net", Dock = DockStyle.Fill };
    readonly Button _enroll = new() { Text = "Enroll từ QR", AutoSize = true };
    readonly Button _start = new() { Text = "▶ Chạy gateway", AutoSize = true };
    readonly Label _status = new() { AutoSize = true, Text = "Đã dừng", Padding = new Padding(8, 6, 0, 0) };
    readonly CheckBox _dedup = new() { Text = "Ẩn dữ liệu lặp", Checked = true, AutoSize = true };
    readonly CheckBox _scroll = new() { Text = "Tự cuộn", Checked = true, AutoSize = true };
    readonly Button _clear = new() { Text = "Xoá bảng", AutoSize = true };
    readonly DataGridView _tbl = new();
    readonly System.Windows.Forms.Timer _ui = new() { Interval = 500 };
    readonly Dictionary<string, string> _last = new();
    readonly List<(DateTime T, string Dir, string Ch, string Text)> _pending = new();
    ScadaHost? _host;

    static ScadaConfig Defaults() => new()
    {
        Site = "factory1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PollMs = 300,
        Mobile = MobileAccess.Control, LocalBrokerEnabled = true, LocalBind = "0.0.0.0", WebEnabled = false,
        LocalUsers = new() { new LocalUser { User = "gw", Password = "", Role = LocalRole.Device } },
        CloudTelemetryMinMs = 2000,
    };

    static string SettingsPath => ConfigStore.PathFor("gateway-app");

    public MainForm()
    {
        Text = "Gateway C# — PLC ⇄ Cloud/Webapp";
        Width = 1300; Height = 800; StartPosition = FormStartPosition.CenterScreen;
        try { if (File.Exists(SettingsPath)) CopyFrom(ConfigStore.Load(SettingsPath)); } catch { /* dùng mặc định */ }
        _grid.SelectedObject = _cfg;

        var top = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 5, Padding = new Padding(6) };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.Controls.Add(new Label { Text = "API webapp", AutoSize = true, Anchor = AnchorStyles.Left });
        top.Controls.Add(_api);
        top.Controls.Add(new Label { Text = "Mã QR tem", AutoSize = true, Anchor = AnchorStyles.Left });
        top.Controls.Add(_qr);
        top.Controls.Add(_enroll);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(6, 0, 6, 4) };
        bar.Controls.AddRange(new Control[] { _start, _dedup, _scroll, _clear, _status });

        _tbl.Dock = DockStyle.Fill; _tbl.ReadOnly = true; _tbl.AllowUserToAddRows = false; _tbl.RowHeadersVisible = false;
        _tbl.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
        _tbl.Columns.Add("t", "Giờ"); _tbl.Columns.Add("d", "Hướng"); _tbl.Columns.Add("c", "Kênh / topic"); _tbl.Columns.Add("x", "Dữ liệu");
        _tbl.Columns[0].Width = 90; _tbl.Columns[1].Width = 150; _tbl.Columns[2].Width = 250; _tbl.Columns[3].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _tbl.DefaultCellStyle.Font = new Font("Consolas", 9f);
        _tbl.SelectionChanged += (_, _) => { };

        var split = new SplitContainer { Dock = DockStyle.Fill, SplitterDistance = 430 };
        split.Panel1.Controls.Add(_grid);
        split.Panel2.Controls.Add(_tbl);
        Controls.Add(split); Controls.Add(bar); Controls.Add(top);

        _enroll.Click += async (_, _) => await EnrollAsync();
        _start.Click += async (_, _) => await ToggleAsync();
        _clear.Click += (_, _) => _tbl.Rows.Clear();
        _ui.Tick += (_, _) => Flush();
        _ui.Start();
        FormClosing += async (_, _) => { await StopAsync(); };
        if (Environment.GetCommandLineArgs().Contains("--autostart")) Shown += async (_, _) => await ToggleAsync();
    }

    void CopyFrom(ScadaConfig s)
    {
        foreach (var p in typeof(ScadaConfig).GetProperties().Where(p => p.CanWrite && p.GetCustomAttributes(typeof(System.Text.Json.Serialization.JsonIgnoreAttribute), true).Length == 0))
            p.SetValue(_cfg, p.GetValue(s));
    }

    // ------------------------------------------------------------------ enroll
    async Task EnrollAsync()
    {
        if (string.IsNullOrWhiteSpace(_qr.Text)) { MessageBox.Show("Dán mã QR của tem vào ô \"Mã QR tem\"."); return; }
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(_api.Text.Trim()), Timeout = TimeSpan.FromSeconds(15) };
            var kit = await new GatewayEnrollClient(http).EnrollAsync(_qr.Text.Trim());
            if (kit == null) throw new InvalidOperationException("server không trả dữ liệu");
            _cfg.Site = kit.Site ?? _cfg.Site; _cfg.Device = kit.Device ?? _cfg.Device;
            if (kit.Mqtt != null)
            {
                _cfg.CloudUser = kit.Mqtt.Username ?? _cfg.CloudUser;
                _cfg.CloudPassword = kit.Mqtt.Password ?? _cfg.CloudPassword;
                // MQTTS thẳng VPS dùng chứng chỉ tự ký khi chưa có chứng chỉ Caddy: cần điền CloudPinSha256 (vân tay trong log HAProxy)
                if (Uri.TryCreate(kit.Mqtt.Mqtts, UriKind.Absolute, out var u)) { _cfg.CloudHost = u.Host; _cfg.CloudPort = u.Port; _cfg.CloudTransport = "mqtts"; }
            }
            // Pack: mỗi field một thanh ghi D liên tiếp từ D50 (PlcSim dùng cùng quy ước). Boolean-like → scale 1, còn lại 10.
            var addr = 50; var pack = new List<PackMap>();
            foreach (var c in kit.Pack ?? new())
                foreach (var f in c.Fields ?? new())
                {
                    var lim = c.Limits != null && c.Limits.TryGetValue(f, out var l) ? l : null;
                    pack.Add(new PackMap { Child = c.Id ?? "", Field = f, Address = addr++, Scale = f is "run" or "on" or "v" ? 1 : 10, Min = lim?.Min, Max = lim?.Max });
                }
            _cfg.Pack = pack;
            _cfg.Mobile = MobileAccess.Control;
            _grid.Refresh();
            Trace("INFO", "enroll", $"site={_cfg.Site} device={_cfg.Device} cloud={_cfg.CloudHost}:{_cfg.CloudPort} user={_cfg.CloudUser} pack={pack.Count} field");
        }
        catch (Exception ex) { MessageBox.Show("Enroll lỗi: " + ex.Message); }
    }

    // ------------------------------------------------------------------ chạy
    async Task ToggleAsync()
    {
        if (_host != null) { await StopAsync(); return; }
        var err = _cfg.Validate();
        if (err != null) { MessageBox.Show(err); return; }
        try { ConfigStore.Save(SettingsPath, _cfg); } catch { /* không quan trọng */ }
        try
        {
            _host = new ScadaHost(_cfg);
            _host.Log += l => Trace("LOG", "gateway", l);
            _host.Core.Traffic += (d, c, t) => Trace(d, c, t);
            await _host.StartAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show("Không chạy được: " + ex.Message);
            if (_host != null) { try { await _host.DisposeAsync(); } catch { /* ignore */ } _host = null; }
            return;
        }
        _start.Text = "■ Dừng"; _grid.Enabled = false; _enroll.Enabled = false;
    }

    async Task StopAsync()
    {
        var h = _host; _host = null;
        if (h != null) { try { await h.DisposeAsync(); } catch { /* ignore */ } }
        _start.Text = "▶ Chạy gateway"; _grid.Enabled = true; _enroll.Enabled = true;
        _status.Text = "Đã dừng";
    }

    // ------------------------------------------------------------------ traffic
    void Trace(string dir, string ch, string text)
    {
        lock (_pending) _pending.Add((DateTime.Now, dir, ch, text));
    }

    void Flush()
    {
        (DateTime T, string Dir, string Ch, string Text)[] batch;
        lock (_pending) { batch = _pending.ToArray(); _pending.Clear(); }
        foreach (var (t, dir, ch, text) in batch)
        {
            var key = dir + "|" + ch;
            if (_dedup.Checked && dir is "PLC→GW" or "GW→Cloud" && _last.TryGetValue(key, out var prev) && prev == text) continue;
            _last[key] = text;
            var i = _tbl.Rows.Add(t.ToString("HH:mm:ss.fff"), dir, ch, text);
            _tbl.Rows[i].DefaultCellStyle.ForeColor = dir switch
            {
                "PLC→GW" => Color.DarkGreen,
                "GW→PLC" => Color.DarkOrange,
                "Cloud→GW" => Color.Purple,
                var x when x.StartsWith("GW→Cloud") => Color.RoyalBlue,
                _ => Color.Gray,
            };
        }
        while (_tbl.Rows.Count > 3000) _tbl.Rows.RemoveAt(0);
        if (batch.Length > 0 && _scroll.Checked && _tbl.Rows.Count > 0) _tbl.FirstDisplayedScrollingRowIndex = _tbl.Rows.Count - 1;
        if (_host != null)
            _status.Text = $"● {_cfg.Source} | cloud: {_host.Cloud} | broker LAN: {_host.LocalClients} client | PLC: {_host.Core.State.Status}";
    }
}
