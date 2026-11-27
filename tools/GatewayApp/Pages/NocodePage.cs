using System.Text;
using System.Text.Json;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Trang "Gateway mua sẵn": cài đặt gateway công nghiệp chỉ cấu hình được — hiện hỗ trợ USR-M100 — CHỈ làm ở đây, webapp không có giao diện này.
///  - Thêm: gateway PC bắt tay với VPS (ký khoá máy) → server tạo gateway no-code cho chủ của gateway PC, trả PHIẾU CẤU HÌNH
///    (host, cổng, user, mật khẩu hiện MỘT lần, client ID, topic, LWT) + file CA để nhập vào trang web của gateway mua sẵn.
///  - Ánh xạ: xem bản tin gần nhất gateway mua sẵn gửi lên → soạn JSON (thiết bị / field / đường dẫn, tuỳ chọn điều khiển) → xem thử → lưu.
///    Lưu xong webapp tự dựng thẻ/widget. Gateway mua sẵn nối THẲNG VPS: PC này tắt cũng không sao.
/// Sửa (thêm / lưu ánh xạ / xoay mật khẩu) cần mật khẩu gateway như sửa cấu hình. Xem docs/NOCODE-GATEWAY.md.
/// </summary>
sealed class NocodePage : UserControl
{
    readonly MainForm _app;
    readonly DataGridView _list = new() { Dock = DockStyle.Fill };
    readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Top, Height = 30, ForeColor = Theme.Muted, Font = Theme.Normal, Padding = new Padding(2, 6, 2, 0) };
    readonly Label _info = new() { AutoSize = false, Dock = DockStyle.Top, Height = 40, ForeColor = Theme.Muted, Font = Theme.Normal, Padding = new Padding(2, 2, 2, 0) };
    readonly TextBox _raw = Box(readOnly: true, height: 120);
    readonly TextBox _map = Box(readOnly: false, height: 260);
    readonly TextBox _out = Box(readOnly: true, height: 110);
    readonly FlatButton _add = new() { Caption = "+ Thêm gateway mua sẵn", Width = 210, Primary = true };
    readonly FlatButton _sheetBtn = new() { Caption = "Thông số kết nối", Width = 150, Enabled = false };
    readonly FlatButton _rotate = new() { Caption = "Xoay mật khẩu", Width = 140, Enabled = false };
    readonly FlatButton _ca = new() { Caption = "Lưu file CA…", Width = 130 };
    readonly FlatButton _draft = new() { Caption = "Tạo nháp từ bản tin", Width = 170, Enabled = false };
    readonly FlatButton _m100 = new() { Caption = "Mẫu USR-M100", Width = 140, Enabled = false };
    readonly FlatButton _preview = new() { Caption = "Xem thử", Width = 110, Enabled = false };
    readonly FlatButton _save = new() { Caption = "✔ Lưu ánh xạ", Width = 140, Primary = true, Enabled = false };
    string? _target;           // ID gateway mua sẵn đang chọn
    JsonElement? _sheet;       // phiếu cấu hình (không có mật khẩu) của gateway đang chọn
    string _lastRaw = "";
    bool _loading;

    static TextBox Box(bool readOnly, int height)
    {
        var t = new TextBox { Multiline = true, ReadOnly = readOnly, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Top, Height = height, AcceptsTab = !readOnly };
        Skin.Input(t); t.Font = Theme.Mono;
        return t;
    }

    public NocodePage(MainForm app)
    {
        _app = app;
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_list);
        foreach (var (n, t, w) in new[] { ("name", "Tên", 180), ("id", "ID", 130), ("st", "Trạng thái", 90), ("last", "Bản tin cuối", 120), ("rev", "Ánh xạ", 70) })
        { _list.Columns.Add(n, t); _list.Columns[n]!.Width = w; }
        _list.Columns["name"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _list.SelectionMode = DataGridViewSelectionMode.FullRowSelect; _list.MultiSelect = false; _list.ReadOnly = true;
        _list.SelectionChanged += async (_, _) => { if (!_loading) await SelectAsync(); };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6), WrapContents = false };
        var reload = new FlatButton { Caption = "↻ Tải lại", Width = 110 };
        reload.Click += async (_, _) => await LoadAsync();
        _add.Click += async (_, _) => await Guard(AddAsync);
        _sheetBtn.Click += (_, _) => { if (_sheet is { } s) SheetForm.Show(this, "Thông số kết nối", s, null); };
        _rotate.Click += async (_, _) => await Guard(RotateAsync);
        _ca.Click += async (_, _) => await Guard(SaveCaAsync);
        bar.Controls.AddRange(new Control[] { _add, _sheetBtn, _rotate, _ca, reload });

        var listCard = new Card { Title = "Gateway mua sẵn của gateway này", Sub = "Nối thẳng VPS bằng MQTTS · webapp thấy như mọi gateway", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        listCard.Controls.Add(_list);

        var mapBar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 46, BackColor = Theme.Panel, Padding = new Padding(0, 4, 0, 4), WrapContents = false };
        _draft.Click += (_, _) => { if (_lastRaw.Length > 0 && Ask.Yes(FindForm(), "Thay nội dung ô ánh xạ bằng bản nháp tạo từ bản tin gần nhất?", "Tạo nháp")) _map.Text = NocodeDraft.FromRaw(_lastRaw); };
        _preview.Click += async (_, _) => await Guard(PreviewAsync);
        _save.Click += async (_, _) => await Guard(SaveAsync);
        _m100.Click += (_, _) =>
        {
            if (!Ask.Yes(FindForm(), "Thay ô ánh xạ bằng mẫu USR-M100 (Relay 1–2 điều khiển được + Đầu vào 1–2)?\n\n"
                + "Trên M100 cần: điểm tên DO1, DO2 (coil 00001/00002, mã hàm 01), DI1, DI2 (10001/10002, mã hàm 02);\n"
                + "mẫu báo dữ liệu " + NocodeDraft.M100ReportTemplate + " (đã chép vào clipboard).", "Mẫu USR-M100")) return;
            _map.Text = NocodeDraft.M100Template();
            try { Clipboard.SetText(NocodeDraft.M100ReportTemplate); } catch { }
            Say("Đã điền mẫu USR-M100 — bấm Xem thử rồi Lưu ánh xạ. Mẫu báo dữ liệu cho M100 đã chép vào clipboard.");
        };
        mapBar.Controls.AddRange(new Control[] { _m100, _draft, _preview, _save });
        var help = new Label
        {
            AutoSize = false, Dock = DockStyle.Top, Height = 58, ForeColor = Theme.Muted, Font = Theme.Small, BackColor = Theme.Panel,
            Text = "Field: key, lbl, unit, widget (gauge, chart, kpi, led_status, ring…), path ($.I1, $.data[0].v), tuỳ chọn scale/offset, min/max, low/high.\n"
                 + "Điều khiển USR-M100: \"control\":\"usr_rw_prot\" ở gốc; field ghi: \"writable\":true, \"point\":\"DO1\" (tên điểm trên M100), \"widget\":\"switch\", nên có \"toggleMs\".\n"
                 + "Lệnh tới gateway mua sẵn KHÔNG có chữ ký: chỉ cho ghi đầu ra không nguy hiểm, khoá liên động an toàn đặt trong PLC.",
        };
        var mapCard = new Card { Title = "Ánh xạ dữ liệu", Sub = "Bản tin của hãng → thiết bị / field trên dashboard", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6), AutoScroll = true };
        // Dock=Top xếp ngược thứ tự thêm: thêm từ dưới lên
        foreach (var c in new Control[] { _out, Caption("Kết quả xem thử"), mapBar, help, _map, Caption("Ánh xạ (JSON)"), _raw, Caption("Bản tin gần nhất gateway mua sẵn gửi lên"), _info })
            mapCard.Controls.Add(c);

        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, BackColor = Theme.Bg, SplitterWidth = 8, SplitterDistance = 420 };
        split.Panel1.Controls.Add(listCard); split.Panel2.Controls.Add(mapCard);
        Controls.Add(split); Controls.Add(_status); Controls.Add(bar);
        VisibleChanged += async (_, _) => { if (Visible) await LoadAsync(); };
    }

    static Label Caption(string t) => new() { Text = t, AutoSize = false, Dock = DockStyle.Top, Height = 24, ForeColor = Theme.Text, Font = Theme.Semi, BackColor = Theme.Panel, Padding = new Padding(0, 4, 0, 0) };

    /// <summary>Kết quả từng bước: GIỮ trên dòng trạng thái + ghi Nhật ký.</summary>
    void Say(string t, bool err = false) { _status.Text = t; _status.ForeColor = err ? Theme.Red : Theme.Text; _app.NocodeLog(t, err); }

    async Task Guard(Func<Task> f)
    {
        try { await f(); }
        catch (Exception e) { Say("Lỗi: " + Vn(e.Message), true); }
    }

    /// <summary>Mã lỗi server → câu tiếng Việt.</summary>
    static string Vn(string code) => code switch
    {
        "gateway_unclaimed" => "gateway PC này chưa có chủ (chưa ai quét QR) — chưa tạo được gateway mua sẵn.",
        "too_many_gateways" => "tài khoản đã đủ số gateway của gói.",
        "admin_cannot_own" => "tài khoản quản trị không làm chủ gateway.",
        "not_allowed" => "server không nhận chữ ký của gateway này (gateway đã bị khoá, chuyển máy, hoặc giờ máy sai).",
        "not_owner" => "gateway mua sẵn này không thuộc gateway PC này.",
        "no_raw_yet" => "gateway mua sẵn chưa gửi bản tin nào — cấu hình gateway rồi chờ vài giây, bấm ↻ Tải lại.",
        "raw_not_json" => "bản tin không phải JSON.",
        "map_bad_path" => "có field thiếu \"path\" hoặc đường dẫn sai (dạng $.a.b[0]).",
        "map_bad_point_name" => "có field thiếu \"name\" (tên điểm trong mảng).",
        "map_bad_control" => "\"control\" chỉ nhận \"usr_rw_prot\" (USR-M100).",
        "map_devices_missing" => "ánh xạ thiếu danh sách \"devices\".",
        "map_too_large" => "ánh xạ quá lớn (tối đa 16 KB).",
        "rate_limited" => "thao tác quá nhanh, thử lại sau ít phút.",
        _ => code,
    };

    public async Task LoadAsync()
    {
        _status.Text = "Đang tải từ server…"; _status.ForeColor = Theme.Muted;
        try
        {
            var r = await _app.NocodeAsync("list");
            var keep = _target;
            _loading = true;
            _list.Rows.Clear();
            foreach (var g in r.GetProperty("gateways").EnumerateArray())
            {
                var last = g.GetProperty("lastRawAt").ValueKind == JsonValueKind.Number
                    ? DateTimeOffset.FromUnixTimeMilliseconds(g.GetProperty("lastRawAt").GetInt64()).LocalDateTime.ToString("dd/MM HH:mm:ss") : "—";
                var st = g.GetProperty("status").ValueKind == JsonValueKind.String ? g.GetProperty("status").GetString() : "—";
                var i = _list.Rows.Add(g.GetProperty("name").GetString(), g.GetProperty("device").GetString(), st, last, "#" + g.GetProperty("mapRev").GetInt32());
                _list.Rows[i].Tag = g.GetProperty("device").GetString();
            }
            _loading = false;
            var row = _list.Rows.Cast<DataGridViewRow>().FirstOrDefault(x => (string?)x.Tag == keep) ?? _list.Rows.Cast<DataGridViewRow>().FirstOrDefault();
            _list.ClearSelection();
            if (row != null) { row.Selected = true; await SelectAsync(); } else ClearDetail();
            _status.Text = _list.Rows.Count == 0 ? "Chưa có gateway mua sẵn nào. Bấm “+ Thêm gateway mua sẵn”." : $"{_list.Rows.Count} gateway mua sẵn.";
            if (r.TryGetProperty("ca", out var ca) && !ca.GetBoolean()) _status.Text += " (Server chưa đặt file CA.)";
        }
        catch (Exception e) { _loading = false; _status.Text = "Không tải được từ server: " + Vn(e.Message) + " (cần gateway đã đăng ký cloud và có mạng)"; _status.ForeColor = Theme.Red; }
    }

    void ClearDetail()
    {
        _target = null; _sheet = null; _lastRaw = "";
        _raw.Text = _map.Text = _out.Text = ""; _info.Text = "";
        _sheetBtn.Enabled = _rotate.Enabled = _draft.Enabled = _preview.Enabled = _save.Enabled = _m100.Enabled = false;
    }

    async Task SelectAsync()
    {
        var t = _list.SelectedRows.Count > 0 ? _list.SelectedRows[0].Tag as string : null;
        if (t == null) { ClearDetail(); return; }
        _target = t;
        try
        {
            var g = await _app.NocodeAsync("get", t);
            _sheet = g.TryGetProperty("sheet", out var s) && s.ValueKind == JsonValueKind.Object ? s.Clone() : null;
            _lastRaw = g.TryGetProperty("lastRaw", out var lr) && lr.ValueKind == JsonValueKind.Object ? lr.GetProperty("text").GetString() ?? "" : "";
            _raw.Text = _lastRaw.Length > 0 ? Pretty(_lastRaw) : "(chưa có — gateway mua sẵn chưa gửi gì lên topic raw)";
            var map = g.TryGetProperty("map", out var m) && m.ValueKind == JsonValueKind.Object ? m : (JsonElement?)null;
            _map.Text = map is { } mm ? JsonSerializer.Serialize(mm, Pretty_) : (_lastRaw.Length > 0 ? NocodeDraft.FromRaw(_lastRaw) : NocodeDraft.Empty());
            var bad = g.TryGetProperty("badFields", out var b) ? string.Join(", ", b.EnumerateArray().Select(x => x.GetString())) : "";
            _info.Text = $"ID {t} · trạng thái: {(g.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() : "chưa rõ")} · ánh xạ #{g.GetProperty("mapRev").GetInt32()}"
                + (bad.Length > 0 ? $"\nKhông đọc được: {bad}" : "");
            _info.ForeColor = bad.Length > 0 ? Theme.Yellow : Theme.Muted;
            _out.Text = "";
            _sheetBtn.Enabled = _sheet != null; _rotate.Enabled = _preview.Enabled = _save.Enabled = _m100.Enabled = true; _draft.Enabled = _lastRaw.Length > 0;
        }
        catch (Exception e) { Say("Không tải được gateway mua sẵn: " + Vn(e.Message), true); }
    }

    static readonly JsonSerializerOptions Pretty_ = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    static string Pretty(string t) { try { using var d = JsonDocument.Parse(t); return JsonSerializer.Serialize(d.RootElement, Pretty_); } catch (JsonException) { return t; } }

    JsonElement? MapJson()
    {
        try { using var d = JsonDocument.Parse(_map.Text); return d.RootElement.Clone(); }
        catch (JsonException e) { Say("Ánh xạ không phải JSON hợp lệ: " + e.Message, true); return null; }
    }

    async Task AddAsync()
    {
        if (!_app.RequireEdit()) { Say("Chưa nhập mật khẩu gateway — không thêm."); return; }
        var name = KeyPrompt.Ask(FindForm(), "Thêm gateway mua sẵn", "Tên hiển thị (vd. Trạm bơm số 2). Gateway mua sẵn sẽ thuộc chủ của gateway này.");
        if (name == null) return;
        Say("Đang tạo trên server…");
        var r = await _app.NocodeAsync("create", extra: new Dictionary<string, object?> { ["name"] = name });
        var dev = r.GetProperty("device").GetString();
        Say($"✔ Đã tạo gateway mua sẵn {r.GetProperty("name").GetString()} ({dev}). Nhập phiếu cấu hình vào gateway — MẬT KHẨU CHỈ HIỆN MỘT LẦN.");
        SheetForm.Show(this, $"Đã tạo “{r.GetProperty("name").GetString()}”", r.GetProperty("sheet"), _app);
        _target = dev;
        await LoadAsync();
    }

    async Task RotateAsync()
    {
        if (_target is not { } t) return;
        if (!Ask.Yes(FindForm(), $"Cấp mật khẩu MQTT mới cho {t}?\nGateway mua sẵn đang dùng mật khẩu cũ sẽ bị ngắt cho tới khi nhập mật khẩu mới.", "Xoay mật khẩu")) return;
        if (!_app.RequireEdit()) { Say("Chưa nhập mật khẩu gateway — không đổi."); return; }
        var r = await _app.NocodeAsync("rotate", t);
        Say($"✔ Đã cấp mật khẩu mới cho {t}.");
        SheetForm.Show(this, "Mật khẩu mới", r.GetProperty("sheet"), _app);
    }

    async Task PreviewAsync()
    {
        if (_target is not { } t || MapJson() is not { } map) return;
        var r = await _app.NocodeAsync("preview", t, new Dictionary<string, object?> { ["map"] = map });
        var bad = string.Join(", ", r.GetProperty("bad").EnumerateArray().Select(x => x.GetString()));
        _out.Text = JsonSerializer.Serialize(r.GetProperty("d"), Pretty_) + (bad.Length > 0 ? $"\r\n\r\nKhông đọc được: {bad}" : "");
        Say(bad.Length > 0 ? $"Xem thử: có field không đọc được ({bad})." : "Xem thử: đọc được mọi field.", bad.Length > 0);
    }

    async Task SaveAsync()
    {
        if (_target is not { } t || MapJson() is not { } map) return;
        var ctl = map.TryGetProperty("control", out var c) && c.ValueKind != JsonValueKind.Null;
        var q = $"Lưu ánh xạ cho {t}? Dashboard trên webapp đổi theo ngay."
            + (ctl ? "\n\nÁnh xạ này BẬT ĐIỀU KHIỂN: webapp sẽ có nút bấm gửi lệnh xuống gateway mua sẵn. Lệnh không có chữ ký — chỉ dùng cho đầu ra không nguy hiểm." : "");
        if (!Ask.Yes(FindForm(), q, "Lưu ánh xạ")) return;
        if (!_app.RequireEdit()) { Say("Chưa nhập mật khẩu gateway — không lưu."); return; }
        var r = await _app.NocodeAsync("map", t, new Dictionary<string, object?> { ["map"] = map });
        Say($"✔ Đã lưu ánh xạ #{r.GetProperty("rev").GetInt32()} ({r.GetProperty("devices").GetInt32()} thiết bị{(r.GetProperty("control").GetBoolean() ? ", có điều khiển" : "")}).");
        _app.Toast("Đã lưu ánh xạ — webapp tự cập nhật.");
        await LoadAsync();
    }

    async Task SaveCaAsync()
    {
        var pem = await _app.NocodeCaAsync();
        if (pem == null) { Say("Server chưa đặt file CA (liên hệ quản trị viên) — dùng dấu vân tay SHA-256 trong phiếu cấu hình nếu gateway hỗ trợ.", true); return; }
        using var d = new SaveFileDialog { FileName = "plciot-mqtt-ca.crt", Filter = "Chứng chỉ (*.crt)|*.crt|Tất cả|*.*" };
        if (d.ShowDialog(FindForm()) != DialogResult.OK) return;
        File.WriteAllText(d.FileName, pem, new UTF8Encoding(false));
        Say($"✔ Đã lưu file CA: {d.FileName}. Nạp file này vào mục SSL/CA của gateway mua sẵn (chế độ kiểm chứng chỉ server).");
    }
}

/// <summary>Hộp thoại phiếu cấu hình: văn bản chép được + nút chép + lưu file CA.</summary>
static class SheetForm
{
    public static void Show(Control owner, string title, JsonElement sh, MainForm? app)
    {
        string S(string k) => sh.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.String or JsonValueKind.Number ? v.ToString() : "—";
        var topics = sh.GetProperty("topics");
        var lwt = sh.GetProperty("lwt");
        var pw = sh.TryGetProperty("password", out var p) ? p.GetString() : null;
        var nl = "\r\n";
        var text = new StringBuilder()
            .Append("Máy chủ (host):     ").Append(S("host")).Append(nl)
            .Append("Cổng:               ").Append(S("port")).Append(nl)
            .Append("Bảo mật:            TLS ").Append(S("tlsMin")).Append("+ (bắt buộc), kiểm chứng chỉ server bằng file CA").Append(nl)
            .Append("Tên đăng nhập:      ").Append(S("username")).Append(nl)
            .Append("Mật khẩu:           ").Append(pw ?? "(đã ẩn — bấm Xoay mật khẩu để cấp mới)").Append(nl)
            .Append("Client ID:          ").Append(S("clientId")).Append(nl)
            .Append("Clean session:      bật").Append(nl)
            .Append("Topic gửi dữ liệu:  ").Append(topics.GetProperty("publish").GetString()).Append(nl)
            .Append("LWT (di chúc):      ").Append(lwt.GetProperty("topic").GetString()).Append(" = \"").Append(lwt.GetProperty("payload").GetString()).Append("\", retain, QoS 1").Append(nl)
            .Append("Topic nhận lệnh:    ").Append(topics.TryGetProperty("cmd", out var tc) ? tc.GetString() : "—").Append("   (nếu bật điều khiển)").Append(nl)
            .Append("Topic trả lời lệnh: ").Append(topics.TryGetProperty("reply", out var tr) ? tr.GetString() : "—").Append(nl)
            .Append("SHA-256 chứng chỉ:  ").Append(S("pinSha256")).Append(nl).Append(nl)
            .Append("USR-M100 — MQTT: phiên bản 3.1.1, bật SSL/TLS = TLSv1.2, nạp file CA; Clean session bật; Last will như trên.").Append(nl)
            .Append("USR-M100 — Data report: topic gửi dữ liệu như trên, mẫu ").Append(NocodeDraft.M100ReportTemplate).Append(" (thêm \"t\":\"sys_unix_time\" nếu bật NTP).").Append(nl)
            .Append("USR-M100 — điều khiển relay: Protocol conversion → JSON, topic nhận/trả lời như trên; IO function: TẮT \"Restart Hold\" (relay về mặc định sau khởi động lại).")
            .ToString();
        using var f = new Form
        {
            Text = title, StartPosition = FormStartPosition.CenterParent, Width = 820, Height = 520, BackColor = Theme.Bg, ForeColor = Theme.Text,
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Font = Theme.Normal,
        };
        var box = new TextBox { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, Text = text, ScrollBars = ScrollBars.Vertical };
        Skin.Input(box); box.Font = new Font("Consolas", 10f);
        var warn = new Label
        {
            Dock = DockStyle.Top, Height = pw != null ? 30 : 0, ForeColor = Theme.Yellow, Font = Theme.Semi,
            Text = "Mật khẩu chỉ hiện MỘT lần — nhập ngay vào gateway mua sẵn (hoặc chép lại).",
        };
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(6) };
        var ok = new FlatButton { Caption = "Xong", Width = 100, Primary = true };
        ok.Click += (_, _) => f.Close();
        var copy = new FlatButton { Caption = "Chép tất cả", Width = 120 };
        copy.Click += (_, _) => { try { Clipboard.SetText(text); copy.Caption = "Đã chép"; } catch { copy.Caption = "Không chép được"; } };
        bar.Controls.AddRange(new Control[] { ok, copy });
        f.Controls.Add(box); f.Controls.Add(warn); f.Controls.Add(bar);
        f.AcceptButton = null;
        f.ShowDialog(owner.FindForm());
    }
}
