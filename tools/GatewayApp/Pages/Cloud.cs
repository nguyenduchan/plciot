using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Trang Cloud của tool ADMIN: bật/tắt đồng bộ (offline = tắt) và kết nối server bằng tài khoản webapp (đăng nhập qua trình duyệt). Địa chỉ server cố định (không nhập tay).</summary>
sealed class CloudPage : UserControl
{
    /// <summary>Server cloud mặc định cho bản dựng này. Đổi cho từng khách hàng bằng file <c>server.json</c> cạnh file chạy: <c>{ "apiUrl": "https://..." }</c> — không cần build lại.
    /// Mọi thứ còn lại (host/cổng/tài khoản MQTT, id topic, danh sách thiết bị) gateway tự nhận từ server khi ghép cặp bằng QR.</summary>
    public static string DefaultServer => _defaultServer ??= LoadServerFile() ?? FallbackServer;
    const string FallbackServer = "https://plc.dieukhientudong.net";
    static string? _defaultServer;
    static string? LoadServerFile()
    {
        try
        {
            var f = Path.Combine(AppContext.BaseDirectory, "server.json");
            if (!File.Exists(f)) return null;
            try { File.SetAttributes(f, File.GetAttributes(f) | FileAttributes.Hidden); } catch { }   // ẩn khỏi Explorer: người dùng không thấy/không sửa nhầm
            using var d = System.Text.Json.JsonDocument.Parse(File.ReadAllText(f));
            var u = d.RootElement.TryGetProperty("apiUrl", out var v) ? v.GetString()?.Trim().TrimEnd('/') : null;
            return Uri.TryCreate(u, UriKind.Absolute, out var uri) && (uri.Scheme == "https" || uri.Scheme == "http") ? u : null;
        }
        catch { return null; }
    }
    public static string ServerOf(ScadaConfig c) => string.IsNullOrWhiteSpace(c.CloudApiUrl) ? DefaultServer : c.CloudApiUrl.Trim();

    readonly IGatewayApp _app;
    readonly ToggleSwitch _sync = new();
    FlatButton _pair = null!;
    readonly Label _info = new() { UseMnemonic = false, AutoSize = false, Height = 110, Dock = DockStyle.Top, ForeColor = Theme.Muted, Font = Theme.Normal };

    public CloudPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        var card = new Card { Title = "Cloud / webapp", Sub = "tuỳ chọn — hệ thống không có Internet cứ để tắt", Dock = DockStyle.Top, Height = 510 };
        var row = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = Color.Transparent };
        _sync.Location = new Point(0, 9);
        var lbl = new Label { Text = "Đồng bộ lên cloud để xem và điều khiển từ điện thoại", ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = true, Location = new Point(62, 12), BackColor = Color.Transparent };
        row.Controls.AddRange(new Control[] { _sync, lbl });
        _sync.On = app.Config.Mobile != MobileAccess.Off;
        var syncGuard = false;
        _sync.Toggled += on => { if (syncGuard) return; if (!app.RequireEdit()) { syncGuard = true; _sync.On = !on; syncGuard = false; return; } app.Config.Mobile = on ? MobileAccess.Control : MobileAccess.Off; _ = app.ApplyAsync(on ? "Đã bật đồng bộ cloud" : "Đã tắt cloud — chạy hoàn toàn cục bộ (offline)"); };

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        _pair = new FlatButton { Caption = "Đăng nhập & kết nối server", Primary = true, Width = 230 };
        _pair.Click += async (_, _) => await RunPair();
        buttons.Controls.Add(_pair);
        // Hàng 2: việc ít dùng nhưng phải tìm được — đổi mật khẩu mở khoá tại máy, và chuyển gateway đã đăng ký sang PC này (đổi PC / cài lại máy)
        var buttons2 = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        var pw = new FlatButton { Caption = "Đặt / đổi mật khẩu gateway", Width = 230 };
        pw.Click += async (_, _) => { var r = await _app.CloudAsync("password", ServerOf(_app.Config), ""); if (!r.Ok) _app.Toast(r.Msg, true); };
        buttons2.Controls.Add(pw);

        // Kiểu giao diện: do nhà cung cấp (quản trị) đặt trên server — gateway chỉ hiển thị, không tự đổi
        var solRow = new Panel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        var solLbl = Skin.Lbl("Kiểu giao diện"); solLbl.Location = new Point(0, 14);
        _solInfo.Location = new Point(130, 14); _solInfo.AutoSize = true; _solInfo.ForeColor = Theme.Text;
        solRow.Controls.AddRange(new Control[] { solLbl, _solInfo });
        // Tự khoá khi không thao tác: cài đặt theo máy, không cần quyền sửa cấu hình
        var lockRow = new Panel { Dock = DockStyle.Top, Height = 50, BackColor = Color.Transparent, Padding = new Padding(0, 8, 0, 0) };
        var lockLbl = Skin.Lbl("Tự khoá sau"); lockLbl.Location = new Point(0, 14);
        var lockBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260, Location = new Point(130, 10) };
        foreach (var m in AutoLock.Choices) lockBox.Items.Add(AutoLock.Label(m));
        lockBox.SelectedIndex = Math.Max(0, Array.IndexOf(AutoLock.Choices, AutoLock.Minutes));
        lockBox.SelectedIndexChanged += (_, _) => { AutoLock.Minutes = AutoLock.Choices[lockBox.SelectedIndex]; _app.Toast(AutoLock.Minutes == 0 ? "Tắt tự khoá." : $"Sẽ tự khoá sau {AutoLock.Minutes} phút không thao tác."); };
        lockRow.Controls.AddRange(new Control[] { lockLbl, lockBox });
        card.Controls.Add(_info); card.Controls.Add(lockRow); card.Controls.Add(solRow); card.Controls.Add(buttons2); card.Controls.Add(buttons); card.Controls.Add(row);
        Controls.Add(card);
        Refresh2();
        ShowSolution();
    }

    readonly Label _solInfo = new() { Text = "", BackColor = Color.Transparent };

    /// <summary>Hiện kiểu giao diện đang dùng và ai đặt (cập nhật khi vẽ lại trang).</summary>
    void ShowSolution() => _solInfo.Text = SolutionHost.Title.Length > 0 ? $"{SolutionHost.Heading}  —  do nhà cung cấp đặt (chỉ đổi cách hiển thị, không ảnh hưởng quyền điều khiển)" : "Cơ bản  —  nhà cung cấp chưa đặt kiểu giao diện riêng";

    async Task RunPair()
    {
        // Đã đăng ký: "Đổi tài khoản" = xin đổi chủ → phải mở khoá tại máy trước (mật khẩu gateway / webapp), và xác nhận rõ ràng
        if (!string.IsNullOrEmpty(_app.Config.CloudPassword))
        {
            if (!_app.RequireEdit()) return;
            if (MessageBox.Show(FindForm(), "Chuyển gateway này sang tài khoản khác (vd. mất điện thoại/tài khoản cũ)?\n\nBạn đang cầm gateway nên được ưu tiên: đăng nhập tài khoản mới (tạo mới nếu cần) là gateway chuyển NGAY, kèm toàn bộ dữ liệu và cấu hình đã có. Chủ cũ chỉ được báo.", "Đổi tài khoản", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        }
        // Không còn mã ghép cặp: đăng nhập qua trình duyệt (xem LoginForm) rồi server cấp gateway cho tài khoản này
        var r = await _app.CloudAsync("register", ServerOf(_app.Config), "");
        _app.Toast(r.Msg, !r.Ok);
        Refresh2();
    }

    public void Refresh2()
    {
        var c = _app.Config;
        _info.Text = string.IsNullOrEmpty(c.CloudPassword)
            ? $"Chưa đăng ký (ID máy: {_app.HwText} · vân tay: {_app.FingerprintText}).\nBấm \"Đăng nhập & kết nối server\": đăng nhập tài khoản webapp (tên + mật khẩu + mã ghép lấy trên điện thoại), server tự cấp ID và tự gắn gateway vào tài khoản đó, không cần quét QR.\nĐổi PC hoặc cài lại máy: khi mở app sẽ hỏi chuyển gateway cũ sang PC này. QR hiện ở góc phải thanh trên sau khi đăng ký."
            : $"Đã đăng ký: site {c.Site} · thiết bị {c.Device} · ID MQTT {c.MqttId} · broker {c.CloudHost}:{c.CloudPort}. Mật khẩu MQTT được lưu mã hoá trên máy này.\n" + (c.CloudSendData ? "Đã có user — gateway đang gửi data lên cloud." : "Chưa có user — gateway CHỈ đồng bộ setting, chưa gửi data.");
        _sync.On = c.Mobile != MobileAccess.Off;
        if (_pair != null) { _pair.Caption = string.IsNullOrEmpty(c.CloudPassword) ? "Đăng nhập & kết nối server" : "Đổi tài khoản…"; _pair.Invalidate(); }   // đã đăng ký: đăng nhập tài khoản khác = đổi chủ gateway (báo chủ cũ)
    }
}
