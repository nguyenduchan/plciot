using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// CÀI ĐẶT HIỆN TRƯỜNG từ xa, CÙNG LÚC với kỹ thuật viên đang cầm điện thoại tại tủ (docs/MOBILE-SETUP.md): xem đúng những gì KTV đang cài
/// (cổng RS485, thiết bị RS485, DI/DO, giá trị) và sửa được — qua relay MQTT, gọi đúng API /api/m/* mà trang điện thoại dùng.
/// Hai bên thấy việc của nhau: mỗi lần lưu tăng Rev cấu hình; bên lưu với Rev cũ bị từ chối (rev_conflict) → tải lại rồi làm lại.
/// Board chỉ cho sửa khi trang cài đặt hiện trường đang BẬT (đang lắp đặt). Ghi thử / bật-tắt DO / hoàn tất: chỉ KTV tại chỗ.
/// </summary>
sealed class FieldSetupForm : Form
{
    static readonly int[] Bauds = { 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200 };
    static readonly (string V, string N)[] Parities = { ("None", "8-N-1"), ("Even", "8-E-1"), ("Odd", "8-O-1") };
    static readonly int[] Polls = { 500, 1000, 2000, 5000, 10000 };
    static readonly (string K, string N)[] DoIcons = { ("bulb", "Đèn"), ("pump", "Bơm"), ("valve", "Van"), ("fan", "Quạt"), ("motor", "Động cơ"), ("alarm", "Còi"), ("door", "Cửa"), ("do", "Khác") };

    readonly AdminApi _api;
    readonly GatewayRow _gw;
    readonly Label _head = new() { Dock = DockStyle.Top, Height = 54, Padding = new Padding(8, 6, 8, 0), ForeColor = Theme.Text };
    readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 44, ForeColor = Theme.Muted, Padding = new Padding(6, 4, 6, 0) };
    readonly ComboBox _baud = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 110 }, _par = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 90 }, _poll = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 90 };
    readonly DataGridView _devs = new() { Dock = DockStyle.Fill };
    readonly DataGridView _io = new() { Dock = DockStyle.Fill };
    readonly System.Windows.Forms.Timer _timer = new() { Interval = 4000 };
    readonly FlatButton _onOff = new() { Width = 220 };
    JsonObject? _s;                 // /api/m/state gần nhất
    List<JsonObject> _cat = new();  // mẫu thiết bị (board tải từ server)
    int _rev = -1;
    bool _busy, _portDirty, _filling;

    public FieldSetupForm(AdminApi api, GatewayRow gw)
    {
        _api = api; _gw = gw;
        Text = $"Cài đặt hiện trường — {gw.Site}/{gw.Device}";
        Width = 1400; Height = 860; MinimumSize = new Size(1000, 600); StartPosition = FormStartPosition.CenterParent;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;

        foreach (var b in Bauds) _baud.Items.Add(b.ToString());
        foreach (var p in Parities) _par.Items.Add(p.N);
        foreach (var p in Polls) _poll.Items.Add((p / 1000.0).ToString(CultureInfo.InvariantCulture) + " giây");
        foreach (var c in new[] { _baud, _par, _poll }) c.SelectedIndexChanged += (_, _) => { if (!_filling) _portDirty = true; };

        Skin.Grid(_devs);
        foreach (var (n, t, w) in new[] { ("title", "Tên trên app", 220), ("model", "Loại / mẫu", 220), ("id", "Slave ID / kênh", 110), ("vals", "Giá trị hiện tại", 400) })
        { _devs.Columns.Add(n, t); _devs.Columns[n]!.Width = w; }
        _devs.Columns["vals"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _devs.ReadOnly = true; _devs.MultiSelect = false; _devs.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _devs.CellDoubleClick += async (_, e) => { if (e.RowIndex >= 0) await Guard(EditSelectedAsync); };
        Skin.Grid(_io);
        foreach (var (n, t, w) in new[] { ("ch", "Chân", 70), ("st", "Trạng thái", 90), ("name", "Tên trên app", 260) }) { _io.Columns.Add(n, t); _io.Columns[n]!.Width = w; }
        _io.Columns["name"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _io.ReadOnly = true; _io.MultiSelect = false; _io.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _io.CellDoubleClick += async (_, e) => { if (e.RowIndex >= 0) await Guard(() => DioAsync(e.RowIndex)); };

        FlatButton Btn(string cap, int w, Func<Task> act, bool primary = false)
        {
            var b = new FlatButton { Caption = cap, Width = w, Primary = primary };
            b.Click += async (_, _) => await Guard(act);
            return b;
        }
        _onOff.Click += async (_, _) => await Guard(ToggleEnabledAsync);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Theme.Bg, Padding = new Padding(8, 6, 8, 4), WrapContents = false };
        bar.Controls.Add(Btn("＋ Thêm thiết bị RS485", 200, () => DeviceAsync(null), primary: true));
        bar.Controls.Add(Btn("✎ Sửa", 90, EditSelectedAsync));
        bar.Controls.Add(Btn("✕ Xoá", 90, RemoveSelectedAsync));
        bar.Controls.Add(Btn("⟳ Đọc thử", 120, ProbeSelectedAsync));
        bar.Controls.Add(Btn("↻ Tải lại", 100, () => RefreshAsync(true)));
        bar.Controls.Add(_onOff);

        var port = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44, BackColor = Theme.Panel, Padding = new Padding(8, 8, 8, 0), WrapContents = false };
        Label L(string t) => new() { Text = t, AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(10, 6, 4, 0) };
        port.Controls.AddRange(new Control[] { L("Cổng RS485 — baud"), _baud, L("Khung"), _par, L("Chu kỳ đọc"), _poll });
        var savePort = new FlatButton { Caption = "Lưu cổng", Width = 110, Margin = new Padding(12, 0, 0, 0) };
        savePort.Click += async (_, _) => await Guard(SavePortAsync);
        port.Controls.Add(savePort);

        var devCard = new Card { Title = "Thiết bị RS485", Sub = "Đúp chuột để sửa · thông số chi tiết nằm ở mẫu (📚 Thiết bị mẫu)", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        devCard.Controls.Add(_devs); devCard.Controls.Add(port);
        var ioCard = new Card { Title = "DI / DO của board", Sub = "Đúp chuột để đặt tên · bật/tắt thử: KTV tại chỗ", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        ioCard.Controls.Add(_io);
        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, BackColor = Theme.Bg, SplitterWidth = 6 };
        split.Panel1.Controls.Add(devCard); split.Panel2.Controls.Add(ioCard);
        Controls.Add(split); Controls.Add(_status); Controls.Add(bar); Controls.Add(_head);

        _timer.Tick += async (_, _) => { if (!_busy) await Guard(() => RefreshAsync(false)); };
        Shown += async (_, _) => { split.SplitterDistance = Width - 480; await Guard(() => RefreshAsync(true)); _timer.Start(); };
        FormClosed += (_, _) => _timer.Dispose();
    }

    void Status(string s, bool err = false) { _status.Text = s; _status.ForeColor = err ? Theme.Red : Theme.Muted; }

    async Task Guard(Func<Task> act)
    {
        if (_busy) return;
        _busy = true; UseWaitCursor = true;
        try { await act(); }
        catch (Exception e) { Status(AdminApi.Explain(e), true); }
        finally { _busy = false; UseWaitCursor = false; }
    }

    /// <summary>Gọi /api/m/* trên board qua relay. Lỗi board → câu báo; rev_conflict → tải lại ngay.</summary>
    async Task<JsonObject?> CallAsync(string method, string path, object? body = null)
    {
        var (st, text) = await _api.RpcAsync(_gw.Site, _gw.Device, method, path, body == null ? "" : JsonSerializer.Serialize(body));
        JsonObject? j = null;
        try { j = JsonNode.Parse(text) as JsonObject; } catch (JsonException) { }
        if (st == 200 && j?["Ok"]?.GetValue<bool>() != false) return j;
        var err = j?["Err"]?.ToString() ?? st.ToString();
        var msg = j?["Msg"]?.ToString();
        if (err == "rev_conflict") { await RefreshAsync(true); Status(msg ?? "Cấu hình vừa được sửa ở nơi khác — đã tải lại.", true); return null; }
        Status(msg ?? err switch
        {
            "not_found" or "remote_route_blocked" => "Firmware board chưa hỗ trợ cài đặt hiện trường từ xa — cập nhật firmware.",
            "mobile_off" => "Board đang chạy thật — bấm \"Bật cài đặt hiện trường\" trước khi sửa.",
            _ => $"Board báo lỗi: {err}",
        }, true);
        return null;
    }

    /// <summary>Tải trạng thái; full = vẽ lại cả cổng RS485 (không đè ô người dùng đang chọn dở).</summary>
    async Task RefreshAsync(bool full)
    {
        JsonObject? s;
        try
        {
            var (st, text) = await _api.RpcAsync(_gw.Site, _gw.Device, "GET", "/api/m/state", "");
            s = st == 200 ? JsonNode.Parse(text) as JsonObject : null;
            if (s == null) { Status(st == 403 || st == 404 ? "Firmware board chưa hỗ trợ cài đặt hiện trường — cập nhật firmware." : $"Board không trả lời ({st}).", true); return; }
        }
        catch (Exception e) { Status(AdminApi.Explain(e), true); return; }
        var rev = s["Rev"]?.GetValue<int>() ?? 0;
        var changed = rev != _rev;
        _s = s;
        if (changed && _rev >= 0 && s["LastChange"] is JsonObject lc && lc["Rev"]?.GetValue<int>() == rev && !(lc["By"]?.ToString() ?? "").StartsWith("GatewayAdmin"))
            Status($"{lc["By"]} vừa sửa: {lc["What"]}");
        _rev = rev;
        Render(full || changed);
    }

    void Render(bool full)
    {
        var s = _s!;
        var on = s["Enabled"]?.GetValue<bool>() == true;
        var techs = (s["Techs"] as JsonArray)?.Select(x => x?.ToString()).Where(x => !string.IsNullOrEmpty(x)).ToList() ?? new();
        _head.Text = $"{_gw.Site}/{_gw.Device} · {s["Version"]} · cloud {s["Cloud"]} · {(on ? "ĐANG LẮP ĐẶT (cài đặt hiện trường bật)" : "CHẠY THẬT (cài đặt hiện trường tắt — chỉ xem)")}\r\n" +
                     (techs.Count > 0 ? "Kỹ thuật viên đang đăng nhập tại tủ: " + string.Join(", ", techs) : "Chưa có kỹ thuật viên đăng nhập trên điện thoại.") +
                     (s["LastChange"] is JsonObject lc ? $"   ·   Sửa gần nhất: {lc["By"]} — {lc["What"]}" : "");
        _head.ForeColor = on ? Theme.Text : Theme.Yellow;
        _onOff.Caption = on ? "⏻ Tắt cài đặt hiện trường" : "⏻ Bật cài đặt hiện trường";
        if (full && !_portDirty)
        {
            _filling = true;
            var p = s["Port"]!.AsObject();
            _baud.SelectedItem = p["Baud"]?.ToString();
            _par.SelectedIndex = Math.Max(0, Array.FindIndex(Parities, x => x.V == p["Parity"]?.ToString()));
            var pm = p["PollMs"]?.GetValue<int>() ?? 1000;
            _poll.SelectedIndex = Array.IndexOf(Polls, Polls.OrderBy(x => Math.Abs(x - pm)).First());
            _filling = false;
        }
        var devs = Devices("rs485");
        var sel = _devs.CurrentRow?.Index ?? -1;
        if (_devs.Rows.Count != devs.Count) { _devs.Rows.Clear(); foreach (var _ in devs) _devs.Rows.Add(); }
        for (var i = 0; i < devs.Count; i++)
        {
            var d = devs[i];
            var model = d["Model"]?.ToString() ?? "";
            var r = _devs.Rows[i];
            r.Cells["title"].Value = d["Title"]?.ToString() + (d["Paused"] != null ? " (tạm dừng)" : "");
            r.Cells["model"].Value = _cat.FirstOrDefault(t => t["id"]?.ToString() == model)?["name"]?.ToString() ?? (model.Length > 0 ? model : "(GatewayApp)");
            r.Cells["id"].Value = d["Unit"]?.ToString();
            r.Cells["vals"].Value = Vals(d);
            r.Tag = d;
        }
        if (sel >= 0 && sel < _devs.Rows.Count) _devs.CurrentCell = _devs.Rows[sel].Cells[0];
        if (_io.Rows.Count != 16) { _io.Rows.Clear(); for (var i = 0; i < 16; i++) _io.Rows.Add(); }
        for (var i = 0; i < 16; i++)
        {
            var isDo = i < 8; var ch = i % 8 + 1;
            var bit = (s[isDo ? "Do" : "Di"] as JsonArray)?[ch - 1]?.GetValue<int>() == 1;
            var owner = DioOwner(isDo, ch);
            var r = _io.Rows[i];
            r.Cells["ch"].Value = (isDo ? "DO" : "DI") + ch;
            r.Cells["st"].Value = bit ? (isDo ? "BẬT" : "CÓ") : "—";
            r.Cells["st"].Style.ForeColor = bit ? Theme.Green : Theme.Muted;
            r.Cells["name"].Value = owner?["Title"]?.ToString() ?? "(chưa dùng)";
        }
    }

    List<JsonObject> Devices(string kind) => (_s?["Devices"] as JsonArray ?? new()).Select(x => x!.AsObject()).Where(d => d["Kind"]?.ToString() == kind).ToList();
    JsonObject? DioOwner(bool isDo, int ch) => Devices("dio").FirstOrDefault(d => d["Ch"]?.GetValue<int>() == (isDo ? ch : -ch));
    static string Fmt(JsonNode? v) => v is null ? "—" : Math.Round(v.GetValue<double>(), 2).ToString(CultureInfo.InvariantCulture);
    static string Vals(JsonObject d) => string.Join(" · ", (d["Fields"] as JsonArray ?? new()).Select(f => f!.AsObject()).Where(f => f["Access"]?.ToString() != "Write")
        .Select(f => $"{f["Label"]}: {Fmt(f["Value"])} {f["Unit"]}".TrimEnd()));
    JsonObject? Selected() => _devs.CurrentRow?.Tag as JsonObject;

    async Task LoadCatalogAsync()
    {
        var j = await CallAsync("POST", "/api/m/catalog", new { });
        if (j == null) return;
        _cat = (j["Templates"] as JsonArray ?? new()).Select(x => x!.AsObject()).ToList();
        if (j["Msg"] is { } m) Status(m.ToString(), true);
    }

    async Task SavePortAsync()
    {
        if (_baud.SelectedItem == null) return;
        var j = await CallAsync("PUT", "/api/m/port", new { Rev = _rev, Baud = int.Parse((string)_baud.SelectedItem), Parity = Parities[Math.Max(0, _par.SelectedIndex)].V, PollMs = Polls[Math.Max(0, _poll.SelectedIndex)] });
        if (j == null) return;
        _portDirty = false;
        await RefreshAsync(true);
        Status("Đã lưu cổng RS485 — kỹ thuật viên thấy ngay trên điện thoại.");
    }

    async Task ToggleEnabledAsync()
    {
        var on = _s?["Enabled"]?.GetValue<bool>() == true;
        if (on && MessageBox.Show(this, "Tắt cài đặt hiện trường? Kỹ thuật viên sẽ bị đăng xuất và không sửa được nữa (kể cả nhấn BOOT).", "Cài đặt hiện trường", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        var (st, text) = await _api.RpcAsync(_gw.Site, _gw.Device, "PUT", "/api/mobile", JsonSerializer.Serialize(new { Enabled = !on }));
        if (st != 200) { Status($"Board trả lỗi {st}: {text}", true); return; }
        await RefreshAsync(true);
        Status(on ? "Đã tắt — board chạy thật." : "Đã bật — kỹ thuật viên nhấn BOOT rồi mở https://<IP board>/m.");
    }

    async Task EditSelectedAsync()
    {
        var d = Selected(); if (d == null) return;
        if (string.IsNullOrEmpty(d["Model"]?.ToString())) { Status("Thiết bị này cài bằng GatewayApp (không theo mẫu) — sửa trong \"Mở cài đặt\".", true); return; }
        await DeviceAsync(d);
    }

    async Task RemoveSelectedAsync()
    {
        var d = Selected(); if (d == null) return;
        if (MessageBox.Show(this, $"Xoá \"{d["Title"]}\"? Thông số của thiết bị này sẽ không còn trên app.", "Xoá thiết bị", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        if (await CallAsync("POST", "/api/m/remove", new { Rev = _rev, Child = d["Child"]!.ToString() }) == null) return;
        await RefreshAsync(true); Status($"Đã xoá {d["Title"]}.");
    }

    async Task ProbeSelectedAsync()
    {
        var d = Selected(); if (d == null) return;
        Status("Đang đọc thử qua RS485…");
        var (st, text) = await _api.RpcAsync(_gw.Site, _gw.Device, "POST", "/api/m/probe", JsonSerializer.Serialize(new { Child = d["Child"]!.ToString() }));
        Status(ProbeText(JsonNode.Parse(text) as JsonObject, d["Title"]?.ToString() ?? ""), st != 200 || JsonNode.Parse(text)?["Ok"]?.GetValue<bool>() != true);
    }

    static string ProbeText(JsonObject? j, string title) => j?["Ok"]?.GetValue<bool>() == true
        ? $"✓ {title}: " + string.Join(" | ", (j["Items"] as JsonArray ?? new()).Select(x => x!.AsObject()).Select(x => x["Err"] != null ? $"{x["Label"]}: {x["Err"]}" : $"{x["Label"]} {Fmt(x["Value"])} {x["Unit"]}"))
        : $"✗ {title}: {j?["Msg"] ?? j?["Err"] ?? "không đọc được"}";

    /// <summary>Thêm (d = null) hoặc sửa thiết bị RS485 theo mẫu — cùng 3 thông tin như trên điện thoại + chọn thông số hiện trên app.</summary>
    async Task DeviceAsync(JsonObject? d)
    {
        if (_cat.Count == 0) { Status("Đang tải danh sách mẫu…"); await LoadCatalogAsync(); }
        if (_cat.Count == 0) { Status("Chưa có mẫu thiết bị nào — thêm trong 📚 Thiết bị mẫu.", true); return; }
        using var f = new Form { Text = d == null ? "Thêm thiết bị RS485" : $"Sửa — {d["Title"]}", Width = 640, Height = 640, StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg, ForeColor = Theme.Text, Font = Theme.Normal, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var tpl = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        foreach (var t in _cat) tpl.Items.Add($"{t["name"]}  ({t["brand"]} {t["model"]})");
        var used = Devices("rs485").Where(x => x["Child"]?.ToString() != d?["Child"]?.ToString()).ToDictionary(x => x["Unit"]!.GetValue<int>(), x => x["Title"]!.ToString());
        var unit = new NumericUpDown { Minimum = 1, Maximum = 247, Dock = DockStyle.Top, Value = d?["Unit"]?.GetValue<int>() ?? Enumerable.Range(1, 247).First(i => !used.ContainsKey(i)) };
        var unitErr = new Label { Dock = DockStyle.Top, Height = 22, ForeColor = Theme.Red };
        var title = new TextBox { Dock = DockStyle.Top, Text = d?["Title"]?.ToString() ?? "" }; Skin.Input(title);
        var fields = new CheckedListBox { Dock = DockStyle.Fill, CheckOnClick = true, BackColor = Theme.Panel, ForeColor = Theme.Text, BorderStyle = BorderStyle.None };
        var probe = new Label { Dock = DockStyle.Bottom, Height = 60, ForeColor = Theme.Muted };
        var shown = (d?["Fields"] as JsonArray)?.Select(x => x!["Field"]!.ToString()).ToHashSet();
        JsonObject? cur = null;
        void FillFields()
        {
            fields.Items.Clear();
            if (tpl.SelectedIndex < 0) return;
            cur = _cat[tpl.SelectedIndex];
            foreach (var fl in (cur["fields"] as JsonArray)!.Select(x => x!.AsObject()))
            {
                var acc = fl["access"]?.ToString();
                var txt = $"{fl["label"]}{(fl["unit"]?.ToString() is { Length: > 0 } u ? $" ({u})" : "")}{(acc == "w" ? "  · lệnh" : acc == "rw" ? "  · đọc/ghi" : "")}";
                fields.Items.Add(txt, shown != null ? shown.Contains(fl["key"]!.ToString()) : fl["show"]?.GetValue<bool>() != false);
            }
            shown = null;   // đổi mẫu: dùng dấu tích mặc định của mẫu mới
            title.PlaceholderText = cur["name"]?.ToString();
        }
        void CheckUnit() => unitErr.Text = used.TryGetValue((int)unit.Value, out var who)
            ? $"Địa chỉ ID {unit.Value} đã dùng cho \"{who}\" (gợi ý: ID {Enumerable.Range(1, 247).First(i => !used.ContainsKey(i) && i != unit.Value)})." : "";
        tpl.SelectedIndexChanged += (_, _) => FillFields();
        unit.ValueChanged += (_, _) => CheckUnit();
        var idx = d == null ? -1 : _cat.FindIndex(t => t["id"]?.ToString() == d["Model"]?.ToString());
        tpl.SelectedIndex = idx >= 0 ? idx : 0;
        CheckUnit();

        var ok = new FlatButton { Caption = "Lưu", Width = 120, Primary = true };
        var test = new FlatButton { Caption = "Đọc thử", Width = 120 };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 100 };
        cancel.Click += (_, _) => f.Close();
        test.Click += async (_, _) =>
        {
            if (cur == null) return;
            probe.Text = "Đang đọc thử…";
            var (_, text) = await _api.RpcAsync(_gw.Site, _gw.Device, "POST", "/api/m/probe", JsonSerializer.Serialize(new { Template = cur["id"]!.ToString(), Unit = (int)unit.Value }));
            var j = JsonNode.Parse(text) as JsonObject;
            probe.Text = ProbeText(j, "Slave " + unit.Value); probe.ForeColor = j?["Ok"]?.GetValue<bool>() == true ? Theme.Green : Theme.Red;
        };
        ok.Click += async (_, _) =>
        {
            if (cur == null || unitErr.Text.Length > 0) return;
            var keys = (cur["fields"] as JsonArray)!.Select((x, i) => (Key: x!["key"]!.ToString(), On: fields.GetItemChecked(i))).Where(x => x.On).Select(x => x.Key).ToArray();
            if (keys.Length == 0) { probe.Text = "Chọn ít nhất một thông số."; probe.ForeColor = Theme.Red; return; }
            ok.Enabled = false;
            var j = await CallAsync("POST", "/api/m/device", new { Rev = _rev, Template = cur["id"]!.ToString(), Unit = (int)unit.Value, Title = title.Text.Trim(), Show = keys, Child = d?["Child"]?.ToString() });
            ok.Enabled = true;
            if (j == null) { probe.Text = _status.Text; probe.ForeColor = Theme.Red; return; }
            f.Close();
            await RefreshAsync(true);
            Status((j["Msg"]?.ToString() ?? "Đã lưu") + " — nhờ kỹ thuật viên bấm \"Đọc thử\" tại tủ để chắc đấu dây đúng.");
        };
        var btns = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(4) };
        btns.Controls.AddRange(new Control[] { ok, test, cancel });
        Label H(string t) => new() { Text = t, Dock = DockStyle.Top, Height = 26, ForeColor = Theme.Muted, Padding = new Padding(0, 6, 0, 0) };
        var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14) };
        body.Controls.Add(fields);
        foreach (var c in new Control[] { H("Thông số hiện trên app chủ xưởng"), title, H("3. Tên gọi hiển thị trên app"), unitErr, unit, H("2. Địa chỉ trạm (Slave ID)"), tpl, H("1. Loại thiết bị") }) body.Controls.Add(c);
        f.Controls.Add(body); f.Controls.Add(probe); f.Controls.Add(btns);
        _timer.Stop();
        try { f.ShowDialog(this); } finally { _timer.Start(); }
    }

    /// <summary>Đặt tên DI/DO (row 0–7 = DO1..8, 8–15 = DI1..8).</summary>
    async Task DioAsync(int row)
    {
        var isDo = row < 8; var ch = row % 8 + 1;
        var owner = DioOwner(isDo, ch);
        using var f = new Form { Text = (isDo ? "DO" : "DI") + ch, Width = 460, Height = isDo ? 330 : 220, StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg, ForeColor = Theme.Text, Font = Theme.Normal, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var name = new TextBox { Dock = DockStyle.Top, Text = owner?["Title"]?.ToString() ?? "", PlaceholderText = isDo ? "Ví dụ: Đèn kho" : "Ví dụ: Cửa tủ mở" }; Skin.Input(name);
        var icon = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        foreach (var x in DoIcons) icon.Items.Add(x.N);
        icon.SelectedIndex = Math.Max(0, Array.FindIndex(DoIcons, x => x.K == owner?["Icon"]?.ToString()));
        var fb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        fb.Items.Add("Không có"); for (var i = 1; i <= 8; i++) fb.Items.Add("DI" + i);
        var fbLabel = (owner?["Fields"] as JsonArray)?.Select(x => x!.AsObject()).FirstOrDefault(x => x["Field"]?.ToString() == "fb")?["Label"]?.ToString() ?? "";
        fb.SelectedIndex = fbLabel.Length > 0 && int.TryParse(fbLabel[^1..], out var n) ? n : 0;
        var ok = new FlatButton { Caption = "Lưu", Width = 110, Primary = true };
        var del = new FlatButton { Caption = "Bỏ khỏi app", Width = 130 };
        del.Visible = owner != null;
        ok.Click += async (_, _) =>
        {
            var j = await CallAsync("POST", "/api/m/dio", new { Rev = _rev, Kind = isDo ? "do" : "di", Ch = ch, Title = name.Text.Trim(), Icon = isDo ? DoIcons[icon.SelectedIndex].K : "di", Fb = isDo ? fb.SelectedIndex : 0, Child = owner?["Child"]?.ToString() });
            if (j != null) { f.Close(); await RefreshAsync(true); Status($"Đã lưu {(isDo ? "DO" : "DI")}{ch}."); }
        };
        del.Click += async (_, _) =>
        {
            if (await CallAsync("POST", "/api/m/remove", new { Rev = _rev, Child = owner!["Child"]!.ToString() }) != null) { f.Close(); await RefreshAsync(true); }
        };
        var btns = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(4) };
        btns.Controls.AddRange(new Control[] { ok, del });
        Label H(string t) => new() { Text = t, Dock = DockStyle.Top, Height = 26, ForeColor = Theme.Muted, Padding = new Padding(0, 6, 0, 0) };
        var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14) };
        var ctl = isDo ? new Control[] { fb, H("Tín hiệu phản hồi (DI)"), icon, H("Loại"), name, H("Tên hiện trên app") } : new Control[] { name, H("Tên hiện trên app") };
        foreach (var c in ctl) body.Controls.Add(c);
        f.Controls.Add(body); f.Controls.Add(btns);
        _timer.Stop();
        try { f.ShowDialog(this); } finally { _timer.Start(); }
        await Task.CompletedTask;
    }
}
