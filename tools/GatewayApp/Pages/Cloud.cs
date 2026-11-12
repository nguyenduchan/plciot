using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Trang Cloud của tool ADMIN: bật/tắt đồng bộ (offline = tắt), ghép cặp/enroll bằng QR (gateway thực hiện), cấu hình nâng cao. Gateway không còn trang này.</summary>
sealed class CloudPage : UserControl
{
    readonly IGatewayApp _app;
    public readonly TextBox Api = new() { Text = "https://plc.dieukhientudong.net" };
    public readonly TextBox Qr = new();
    public readonly TextBox Pair = new();
    readonly ToggleSwitch _sync = new();
    readonly Label _info = new() { AutoSize = false, Height = 110, Dock = DockStyle.Top, ForeColor = Theme.Muted, Font = Theme.Normal };

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
        t.Controls.Add(Skin.Lbl("Mã ghép cặp")); Pair.Dock = DockStyle.Fill; Pair.Margin = new Padding(0, 4, 0, 4); Pair.CharacterCasing = CharacterCasing.Upper; t.Controls.Add(Pair);
        t.Controls.Add(Skin.Lbl("Mã QR của tem")); Qr.Dock = DockStyle.Fill; Qr.Margin = new Padding(0, 4, 0, 4); t.Controls.Add(Qr);
        t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        var pair = new FlatButton { Caption = "Kết nối bằng mã", Primary = true, Width = 190 };
        pair.Click += async (_, _) => await RunCloud("pair", Pair, "Nhập mã ghép cặp do admin phát.");
        var enroll = new FlatButton { Caption = "Enroll từ QR (duyệt tay)", Width = 210 };
        var adv = new FlatButton { Caption = "Cấu hình nâng cao…", Width = 190 };
        enroll.Click += async (_, _) => await RunCloud("enroll", Qr, "Dán mã QR của tem vào ô Mã QR của tem.");
        adv.Click += (_, _) => ShowAdvanced();
        buttons.Controls.AddRange(new Control[] { pair, enroll, adv });

        card.Controls.Add(_info); card.Controls.Add(buttons); card.Controls.Add(t); card.Controls.Add(row);
        Controls.Add(card);
        Refresh2();
    }

    async Task RunCloud(string action, TextBox src, string missing)
    {
        var v = src.Text.Trim();
        if (v.Length == 0) { _app.Toast(missing, true); return; }
        var r = await _app.CloudAsync(action, Api.Text.Trim(), v);
        if (r.Ok && action == "pair") src.Text = "";
        _app.Toast(r.Msg, !r.Ok);
        Refresh2();
    }

    public void Refresh2()
    {
        var c = _app.Config;
        _info.Text = string.IsNullOrEmpty(c.CloudPassword)
            ? $"Chưa đăng ký (vân tay gateway: {_app.FingerprintText} · ID máy: {_app.HwText} — đọc cho admin đối chiếu).\n1) Nhập mã ghép cặp admin phát → \"Gửi bản khai cho admin\" (gửi toàn bộ thiết bị + setting + UI).\n2) Admin duyệt và đưa lại QR → dán vào ô QR → Enroll để lấy site, MQTT."
            : $"Đã cấu hình: site {c.Site} · thiết bị {c.Device} · broker {c.CloudHost}:{c.CloudPort}. Mật khẩu MQTT được lưu mã hoá trên máy này.\n" + (c.CloudSendData ? "Đã có user — gateway đang gửi data lên cloud." : "Chưa có user quét QR — gateway CHỈ đồng bộ setting, chưa gửi data. Hãy xác nhận đúng trạm rồi đưa QR cho user quét trên webapp.");
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
