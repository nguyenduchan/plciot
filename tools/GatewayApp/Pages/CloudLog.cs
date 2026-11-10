using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Trang Cloud: bật/tắt đồng bộ (offline = tắt), enroll bằng QR, cấu hình nâng cao.</summary>
sealed class CloudPage : UserControl
{
    readonly IGatewayApp _app;
    public readonly TextBox Api = new() { Text = "https://plc.dieukhientudong.net" };
    public readonly TextBox Qr = new();
    public readonly TextBox Pair = new();
    readonly ToggleSwitch _sync = new();
    readonly Label _info = new() { AutoSize = false, Height = 110, Dock = DockStyle.Top, ForeColor = Theme.Muted, Font = Theme.Normal };
    public Func<Task>? EnrollRequested;
    public Func<Task>? PairRequested;

    public CloudPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        var card = new Card { Title = "Cloud / webapp", Sub = "tuỳ chọn — hệ thống không có Internet cứ để tắt", Dock = DockStyle.Top, Height = 470 };
        Skin.Input(Api); Skin.Input(Qr); Skin.Input(Pair);
        var row = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = Color.Transparent };
        _sync.Location = new Point(0, 9);
        var lbl = new Label { Text = "Đồng bộ lên cloud để xem và điều khiển từ điện thoại", ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = true, Location = new Point(62, 12), BackColor = Color.Transparent };
        row.Controls.AddRange(new Control[] { _sync, lbl });
        _sync.On = app.Config.Mobile != MobileAccess.Off;
        _sync.Toggled += on => { app.Config.Mobile = on ? MobileAccess.Control : MobileAccess.Off; _ = app.ApplyAsync(on ? "Đã bật đồng bộ cloud" : "Đã tắt cloud — chạy hoàn toàn cục bộ (offline)"); };

        var t = new TableLayoutPanel { Dock = DockStyle.Top, Height = 136, ColumnCount = 2, BackColor = Color.Transparent };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        t.Controls.Add(Skin.Lbl("Địa chỉ server")); Api.Dock = DockStyle.Fill; Api.Margin = new Padding(0, 4, 0, 4); t.Controls.Add(Api);
        t.Controls.Add(Skin.Lbl("Mã ghép cặp (admin phát)")); Pair.Dock = DockStyle.Fill; Pair.Margin = new Padding(0, 4, 0, 4); Pair.CharacterCasing = CharacterCasing.Upper; t.Controls.Add(Pair);
        t.Controls.Add(Skin.Lbl("Mã QR của tem")); Qr.Dock = DockStyle.Fill; Qr.Margin = new Padding(0, 4, 0, 4); t.Controls.Add(Qr);
        t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        var pair = new FlatButton { Caption = "Gửi bản khai cho admin", Width = 210 };
        pair.Click += async (_, _) => { if (PairRequested != null) await PairRequested(); Refresh2(); };
        var enroll = new FlatButton { Caption = "Enroll từ QR", Primary = true, Width = 150 };
        var adv = new FlatButton { Caption = "Cấu hình nâng cao…", Width = 190 };
        enroll.Click += async (_, _) => { if (EnrollRequested != null) await EnrollRequested(); Refresh2(); };
        adv.Click += (_, _) => ShowAdvanced();
        buttons.Controls.AddRange(new Control[] { pair, enroll, adv });

        card.Controls.Add(_info); card.Controls.Add(buttons); card.Controls.Add(t); card.Controls.Add(row);
        Controls.Add(card);
        Refresh2();
    }

    public void Refresh2()
    {
        var c = _app.Config;
        _info.Text = string.IsNullOrEmpty(c.CloudPassword)
            ? $"Chưa đăng ký (vân tay gateway: {Fingerprint.Of(_app.Config)}).\n1) Nhập mã ghép cặp admin phát → \"Gửi bản khai cho admin\" (gửi toàn bộ thiết bị + setting + UI).\n2) Admin duyệt và đưa lại QR → dán vào ô QR → Enroll để lấy site, MQTT."
            : $"Đã cấu hình: site {c.Site} · thiết bị {c.Device} · broker {c.CloudHost}:{c.CloudPort}. Mật khẩu MQTT được lưu mã hoá trên máy này.";
        _sync.On = c.Mobile != MobileAccess.Off;
    }

    void ShowAdvanced()
    {
        using var f = new Form { Text = "Cấu hình nâng cao (toàn bộ ScadaConfig)", Width = 560, Height = 760, StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg };
        var g = new PropertyGrid { Dock = DockStyle.Fill, SelectedObject = _app.Config, BackColor = Theme.Panel, ViewBackColor = Theme.Panel, ViewForeColor = Theme.Text, HelpBackColor = Theme.Panel2, HelpForeColor = Theme.Muted, LineColor = Theme.Border, CategoryForeColor = Theme.Muted, CommandsBackColor = Theme.Panel2, DisabledItemForeColor = Theme.Muted };
        f.Controls.Add(g);
        f.ShowDialog(FindForm());
        _ = _app.ApplyAsync("Đã lưu cấu hình nâng cao");
    }
}

/// <summary>Trang Nhật ký: mọi dữ liệu đi/đến của gateway (PLC→GW, GW→Cloud, Cloud→GW, GW→PLC).</summary>
sealed class LogPage : UserControl
{
    readonly DataGridView _tbl = new() { Dock = DockStyle.Fill };
    readonly CheckBox _dedup = new() { Text = "Ẩn dữ liệu lặp", Checked = true, AutoSize = true, ForeColor = Theme.Text, Font = Theme.Normal, Margin = new Padding(14, 9, 0, 0) };
    readonly CheckBox _scroll = new() { Text = "Tự cuộn", Checked = true, AutoSize = true, ForeColor = Theme.Text, Font = Theme.Normal, Margin = new Padding(14, 9, 0, 0) };
    readonly Dictionary<string, string> _last = new();
    readonly List<(DateTime T, string Dir, string Ch, string Text)> _pending = new();

    public LogPage()
    {
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_tbl);
        _tbl.Columns.Add("t", "Giờ"); _tbl.Columns.Add("d", "Hướng"); _tbl.Columns.Add("c", "Kênh / topic"); _tbl.Columns.Add("x", "Dữ liệu");
        _tbl.Columns[0].Width = 110; _tbl.Columns[1].Width = 130; _tbl.Columns[2].Width = 220; _tbl.Columns[3].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _tbl.DefaultCellStyle.Font = Theme.Mono;
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6) };
        var clear = new FlatButton { Caption = "Xoá bảng", Width = 100 };
        clear.Click += (_, _) => _tbl.Rows.Clear();
        bar.Controls.AddRange(new Control[] { clear, _dedup, _scroll });
        var card = new Card { Title = "Nhật ký giao dịch", Sub = "PLC→GW · GW→Cloud · Cloud→GW · GW→PLC", Dock = DockStyle.Fill, Padding = new Padding(2, 40, 2, 2) };
        card.Controls.Add(_tbl);
        Controls.Add(card); Controls.Add(bar);
    }

    public void Add(string dir, string ch, string text) { lock (_pending) _pending.Add((DateTime.Now, dir, ch, text)); }

    public void Flush()
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
                "PLC→GW" => Theme.Green,
                "GW→PLC" => Color.FromArgb(255, 152, 48),
                "Cloud→GW" => Color.FromArgb(184, 119, 217),
                var x when x.StartsWith("GW→Cloud") => Theme.Accent,
                _ => Theme.Muted,
            };
        }
        while (_tbl.Rows.Count > 3000) _tbl.Rows.RemoveAt(0);
        if (batch.Length > 0 && _scroll.Checked && _tbl.Rows.Count > 0) _tbl.FirstDisplayedScrollingRowIndex = _tbl.Rows.Count - 1;
    }
}
