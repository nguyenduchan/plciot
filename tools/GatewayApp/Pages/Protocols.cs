using System.Globalization;
using System.Text.Json;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Thẻ chọn giao thức.</summary>
sealed class ProtoTile : Painted
{
    bool _hot;
    public ProtocolInfo Info { get; }
    public bool Selected { get; set; }
    public bool Active { get; set; }
    public ProtoTile(ProtocolInfo i) { Info = i; Size = new Size(250, 78); Margin = new Padding(0, 0, 12, 12); Cursor = Cursors.Hand; }
    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        g.Clear(Theme.Bg);
        using var path = Theme.Round(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 10);
        using (var b = new SolidBrush(Selected ? Color.FromArgb(40, Theme.Accent) : _hot ? Theme.Panel2 : Theme.Panel)) g.FillPath(b, path);
        using (var p = new Pen(Selected ? Theme.Accent : Theme.Border, Selected ? 1.6f : 1f)) g.DrawPath(p, path);
        var ic = new RectangleF(12, 14, 48, 48);
        using (var ip = Theme.Round(ic, 10)) { using var b = new SolidBrush(Color.FromArgb(50, Info.Color)); g.FillPath(b, ip); }
        TextRenderer.DrawText(g, Info.Icon, Theme.Title, Rectangle.Round(ic), Info.Color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Info.Name, Theme.Semi, new Rectangle(70, 14, Width - 76, 22), Theme.Text, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(g, Info.Desc, Theme.Small, new Rectangle(70, 38, Width - 80, 34), Theme.Muted, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
        if (Active)
        {
            var w = 62; var r = new RectangleF(Width - w - 8, 8, w, 18);
            using var cp = Theme.Round(r, 9); using var b = new SolidBrush(Color.FromArgb(60, Theme.Green)); g.FillPath(b, cp);
            TextRenderer.DrawText(g, "đang dùng", Theme.Small, Rectangle.Round(r), Theme.Green, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }
}

public sealed record ProtocolInfo(PlcSource Source, string Name, string Desc, string Icon, Color Color, string[] Fields);

/// <summary>Trang Giao thức: chọn giao thức nối PLC, nhập thông số, kiểm tra kết nối, áp dụng.</summary>
sealed class ProtocolsPage : UserControl
{
    static readonly string[] S7Cpus = { "S7200", "S7300", "S7400", "S71200", "S71500" };
    static readonly string[] McTypes = { "Q", "L", "QnA", "iQ-R", "iQ-L" };

    public static readonly ProtocolInfo[] All =
    {
        new(PlcSource.ModbusTcp, "Modbus TCP", "PLC/biến tần có cổng Ethernet (Xinje, Delta, Schneider…)", "M", Theme.Accent, new[] { "PlcHost", "PlcPort", "ModbusUnit", "PollMs" }),
        new(PlcSource.ModbusRtu, "Modbus RTU (RS485)", "Cổng COM / USB-RS485. Host = tên cổng, Cổng = baud", "R", Theme.Teal, new[] { "PlcHost", "PlcPort", "SerialParity", "ModbusUnit", "PollMs" }),
        new(PlcSource.S7, "Siemens S7", "S7-200/300/400/1200/1500 qua DB chứa INT[300]", "S", Theme.Green, new[] { "PlcHost", "S7Cpu", "S7Rack", "S7Slot", "S7Db", "PollMs" }),
        new(PlcSource.EtherNetIp, "EtherNet/IP", "Rockwell / Allen-Bradley, tag INT[300]", "E", Theme.Yellow, new[] { "PlcHost", "EipTag", "EipSlot", "PollMs" }),
        new(PlcSource.MitsubishiMc, "Mitsubishi MC", "Giao thức MC 3E nhị phân, thiết bị D", "Q", Theme.Red, new[] { "PlcHost", "PlcPort", "McPlcType", "PollMs" }),
        new(PlcSource.OmronFins, "Omron FINS", "FINS UDP/TCP, vùng DM", "O", Color.FromArgb(255, 152, 48), new[] { "PlcHost", "PlcPort", "FinsProtocol", "FinsDestNode", "FinsSourceNode", "PollMs" }),
        new(PlcSource.BeckhoffAds, "Beckhoff ADS", "TwinCAT qua router ADS", "A", Color.FromArgb(184, 119, 217), new[] { "PlcHost", "AdsNetId", "AdsPort", "AdsSymbol", "PollMs" }),
        new(PlcSource.OpcUa, "OPC UA", "Máy chủ OPC UA bất kỳ", "U", Color.FromArgb(87, 148, 242), new[] { "OpcUaEndpoint", "OpcUaImageNode", "OpcUaWriteNode", "PollMs" }),
        new(PlcSource.Gateway, "Gateway ESP32 (MQTT)", "Gateway phần cứng nối vào broker LAN của máy này", "G", Theme.Muted, new[] { "LocalPort" }),
    };

    static readonly Dictionary<string, string> Labels = new()
    {
        ["PlcHost"] = "Địa chỉ / cổng COM", ["PlcPort"] = "Cổng (0 = mặc định) / baud", ["ModbusUnit"] = "Địa chỉ trạm (unit)", ["PollMs"] = "Chu kỳ đọc (ms)",
        ["SerialParity"] = "Parity", ["S7Cpu"] = "Loại CPU", ["S7Rack"] = "Rack", ["S7Slot"] = "Slot", ["S7Db"] = "Số DB", ["EipTag"] = "Tên tag", ["EipSlot"] = "Slot",
        ["McPlcType"] = "Dòng PLC", ["FinsProtocol"] = "Giao vận", ["FinsDestNode"] = "Node đích (0 = octet cuối IP)", ["FinsSourceNode"] = "Node nguồn",
        ["AdsNetId"] = "AMS NetId", ["AdsPort"] = "Cổng ADS", ["AdsSymbol"] = "Symbol", ["OpcUaEndpoint"] = "Endpoint", ["OpcUaImageNode"] = "Node ảnh thanh ghi",
        ["OpcUaWriteNode"] = "Node ghi ({a} = số D)", ["LocalPort"] = "Cổng broker LAN",
    };

    readonly IGatewayApp _app;
    readonly FlowLayoutPanel _tiles = new() { Dock = DockStyle.Top, AutoSize = true, BackColor = Theme.Bg, WrapContents = true };
    readonly Card _form = new() { Title = "Thông số kết nối", Dock = DockStyle.Fill };
    readonly TableLayoutPanel _fields = new() { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Color.Transparent };
    readonly Label _result = new() { AutoSize = false, Height = 54, Dock = DockStyle.Bottom, Font = Theme.Normal, ForeColor = Theme.Muted };
    readonly Dictionary<string, Control> _inputs = new();
    readonly List<ProtoTile> _tileList = new();
    ProtocolInfo _sel = All[1];

    public ProtocolsPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6) };
        var add = new FlatButton { Caption = "＋  Thêm giao thức", Primary = true, Width = 190 };
        var hint = new Label { Text = "Gateway nối một nguồn PLC mỗi lần; chọn giao thức rồi Áp dụng để chuyển.", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = true, Margin = new Padding(14, 10, 0, 0) };
        add.Click += (_, _) =>
        {
            var m = new ContextMenuStrip { BackColor = Theme.Panel2, ForeColor = Theme.Text, Font = Theme.Normal, ShowImageMargin = false };
            foreach (var p in All) m.Items.Add($"{p.Name}", null, (_, _) => Select(p));
            m.Show(add, new Point(0, add.Height));
        };
        bar.Controls.AddRange(new Control[] { add, hint });

        foreach (var p in All)
        {
            var t = new ProtoTile(p);
            t.Click += (_, _) => Select(p);
            _tileList.Add(t); _tiles.Controls.Add(t);
        }
        var test = new FlatButton { Caption = "Kiểm tra kết nối", Width = 160 };
        var apply = new FlatButton { Caption = "Áp dụng & chạy lại", Primary = true, Width = 190 };
        test.Click += async (_, _) => await TestAsync();
        apply.Click += async (_, _) => await ApplyAsync();
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, BackColor = Color.Transparent };
        buttons.Controls.AddRange(new Control[] { test, apply });
        _form.Controls.Add(_fields); _form.Controls.Add(_result); _form.Controls.Add(buttons);
        _fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220)); _fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(_form); Controls.Add(_tiles); Controls.Add(bar);
        Select(All.FirstOrDefault(p => p.Source == app.Config.Source) ?? All[0]);
    }

    public void Select(ProtocolInfo p)
    {
        _sel = p; _result.Text = ""; _result.ForeColor = Theme.Muted;
        foreach (var t in _tileList) { t.Selected = t.Info == p; t.Active = t.Info.Source == _app.Config.Source; t.Invalidate(); }
        _form.Title = $"Thông số kết nối — {p.Name}"; _form.Sub = p.Source == _app.Config.Source ? "đang dùng" : "chưa áp dụng";
        _fields.SuspendLayout(); _fields.Controls.Clear(); _fields.RowStyles.Clear(); _inputs.Clear();
        foreach (var key in p.Fields)
        {
            var prop = typeof(ScadaConfig).GetProperty(key)!;
            var cur = prop.GetValue(_app.Config);
            Control c;
            string[]? choices = key switch { "S7Cpu" => S7Cpus, "McPlcType" => McTypes, "FinsProtocol" => new[] { "udp", "tcp" }, "SerialParity" => new[] { "Even", "None", "Odd" }, _ => null };
            if (choices != null) { var cb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList }; cb.Items.AddRange(choices); cb.SelectedItem = Convert.ToString(cur); if (cb.SelectedIndex < 0) cb.SelectedIndex = 0; c = cb; }
            else c = new TextBox { Text = Convert.ToString(cur, CultureInfo.InvariantCulture) };
            Skin.Input(c); c.Dock = DockStyle.Fill; c.Margin = new Padding(0, 4, 0, 4);
            _fields.Controls.Add(Skin.Lbl(Labels.GetValueOrDefault(key, key))); _fields.Controls.Add(c);
            _fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            _inputs[key] = c;
        }
        _fields.ResumeLayout();
    }

    /// <summary>Ghi các ô nhập vào cấu hình (hoặc bản sao); trả về lỗi nếu giá trị sai.</summary>
    string? WriteTo(ScadaConfig cfg)
    {
        foreach (var (key, c) in _inputs)
        {
            var prop = typeof(ScadaConfig).GetProperty(key)!;
            var txt = c is ComboBox cb ? Convert.ToString(cb.SelectedItem) ?? "" : c.Text.Trim();
            try
            {
                if (prop.PropertyType == typeof(int)) prop.SetValue(cfg, int.Parse(txt, CultureInfo.InvariantCulture));
                else prop.SetValue(cfg, txt);
            }
            catch (FormatException) { return $"\"{Labels.GetValueOrDefault(key, key)}\" phải là số."; }
        }
        cfg.Source = _sel.Source;
        return cfg.Validate();
    }

    async Task TestAsync()
    {
        if (_sel.Source == PlcSource.Gateway) { Say("Gateway ESP32 tự nối vào broker LAN; không có bước thử ở đây.", Theme.Muted); return; }
        var copy = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(_app.Config))!;
        var err = WriteTo(copy);
        if (err != null) { Say("✖ " + err, Theme.Red); return; }
        Say("Đang thử kết nối…", Theme.Muted);
        try
        {
            using var drv = DriverFactory.Create(copy);
            if (drv == null) { Say("✖ Không tạo được driver.", Theme.Red); return; }
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var r = await drv.ReadAsync(0, 8, cts.Token);
            Say($"✔ Kết nối được. D0..D7 = {string.Join(", ", r)}", Theme.Green);
        }
        catch (OperationCanceledException) { Say("✖ Hết thời gian chờ (5 giây). Kiểm tra địa chỉ, cổng, dây mạng.", Theme.Red); }
        catch (Exception e) { Say("✖ " + e.Message, Theme.Red); }
    }

    async Task ApplyAsync()
    {
        var err = WriteTo(_app.Config);
        if (err != null) { Say("✖ " + err, Theme.Red); return; }
        Select(_sel);
        await _app.ApplyAsync($"Đã chuyển sang {_sel.Name}");
    }

    void Say(string s, Color c) { _result.Text = s; _result.ForeColor = c; }
}
