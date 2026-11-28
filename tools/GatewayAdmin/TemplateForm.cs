using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// THƯ VIỆN THIẾT BỊ MẪU RS485 (cloud/app/src/deviceLibrary.js, docs/MOBILE-SETUP.md): kỹ sư khai báo bảng thanh ghi MỘT LẦN cho mỗi model
/// (biến tần, đồng hồ điện, cảm biến…) → lưu lên server → kỹ thuật viên lắp tủ thấy ngay trên trang cài đặt điện thoại của board Waveshare,
/// chỉ việc chọn loại + Slave ID + tên. Sửa mẫu không đổi thiết bị đã lắp (cấu hình đã chép xuống board); thêm lại / "Sửa" trên điện thoại để áp mẫu mới.
/// </summary>
sealed class TemplateForm : Form
{
    const string Hint =
        "Giá trị hiển thị = số thô ÷ hệ số chia (vd. 5000 ÷ 100 = 50.00 Hz; ghi 30 Hz → gửi 3000).  Địa chỉ: 0x3000 hoặc 12288 — số thanh ghi PDU bắt đầu từ 0 " +
        "(tài liệu ghi 40001 → nhập 0; 30001 → FC04, nhập 0).  Thứ tự byte: 16 bit AB / BA; 32 bit ABCD (word cao trước), CDAB (đảo word), BADC, DCBA.  " +
        "\"Hiện\" = thợ thấy sẵn dấu tích; \"Đọc thử\" = tối đa 3 số hiện khi bấm Đọc thử.  Ctrl+S = lưu lên server.";
    static readonly string[] AccessNames = { "Chỉ đọc", "Đọc & ghi", "Chỉ ghi" }, AccessKeys = { "r", "rw", "w" };
    static readonly string[] FcNames = { "03 Holding", "04 Input" };
    static readonly string[] Types = { "UInt16", "Int16", "UInt32", "Int32", "Float32", "Float64", "Bool" };
    static readonly string[] Orders = { "AB", "BA", "ABCD", "CDAB", "BADC", "DCBA" };
    static readonly string[] KindNames = { "Đồng hồ", "Số lớn", "Bồn", "Công tắc", "Thanh trượt" }, KindKeys = { "gauge", "number", "tank", "toggle", "slider" };
    static readonly string[] Icons = { "vfd", "meter", "env", "pump", "fan", "motor", "compressor", "boiler", "heater", "hvac", "chiller", "generator", "battery", "scale", "ph", "gas", "pressure", "tank", "valve", "dev" };

    readonly AdminApi _api;
    readonly DataGridView _list = new() { Dock = DockStyle.Fill };
    readonly DataGridView _g = new() { Dock = DockStyle.Fill };
    readonly TextBox _id = new(), _name = new(), _brand = new(), _model = new(), _note = new();
    readonly ComboBox _icon = new() { DropDownStyle = ComboBoxStyle.DropDown }, _baud = new() { DropDownStyle = ComboBoxStyle.DropDownList }, _parity = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 44, ForeColor = Theme.Muted, Padding = new Padding(6, 4, 6, 0) };
    List<JsonObject> _tpls = new();
    bool _dirty;

    public TemplateForm(AdminApi api)
    {
        _api = api;
        Text = "Thư viện thiết bị mẫu RS485 — trang cài đặt điện thoại";
        Width = 1560; Height = 880; MinimumSize = new Size(1100, 600); StartPosition = FormStartPosition.CenterParent; KeyPreview = true;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;

        Skin.Grid(_list);
        foreach (var (n, t, w) in new[] { ("id", "Mã", 130), ("name", "Tên", 220), ("rev", "Bản", 50) }) { _list.Columns.Add(n, t); _list.Columns[n]!.Width = w; }
        _list.Columns["name"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _list.MultiSelect = false; _list.SelectionMode = DataGridViewSelectionMode.FullRowSelect; _list.ReadOnly = true;
        _list.CellClick += (_, e) => { if (e.RowIndex >= 0 && e.RowIndex < _tpls.Count && ConfirmLeave()) Show(_tpls[e.RowIndex]); };

        Skin.Grid(_g);
        _g.ReadOnly = false; _g.AllowUserToAddRows = true; _g.AllowUserToDeleteRows = true; _g.EditMode = DataGridViewEditMode.EditOnEnter;
        Text_("key", "Khoá MQTT", 90); Text_("label", "Tên thông số (hiển thị app)", 200); Combo("access", "Thao tác", AccessNames, 100);
        Combo("fc", "FC đọc", FcNames, 100); Text_("addr", "Địa chỉ", 90); Combo("type", "Kiểu dữ liệu", Types, 90); Combo("order", "Thứ tự byte", Orders, 80);
        Text_("scale", "Hệ số chia", 80); Text_("unit", "Đơn vị", 60); Combo("kind", "Hiển thị", KindNames, 100); Text_("min", "Min", 60); Text_("max", "Max", 60);
        Check("show", "Hiện", 50); Check("test", "Đọc thử", 64); Check("wfc", "Ghi FC16", 70); Text_("on", "Chữ khi 1", 80); Text_("off", "Chữ khi 0", 80);
        _g.Columns["label"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _g.DefaultValuesNeeded += (_, e) => { e.Row.Cells["access"].Value = AccessNames[0]; e.Row.Cells["fc"].Value = FcNames[0]; e.Row.Cells["type"].Value = "UInt16"; e.Row.Cells["order"].Value = "AB"; e.Row.Cells["scale"].Value = "1"; e.Row.Cells["kind"].Value = KindNames[0]; e.Row.Cells["show"].Value = true; };
        _g.CellValueChanged += (_, _) => _dirty = true;
        _g.CurrentCellDirtyStateChanged += (_, _) => { if (_g.IsCurrentCellDirty) _g.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        _g.DataError += (_, e) => e.ThrowException = false;

        foreach (var b in new[] { 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200 }) _baud.Items.Add(b.ToString());
        _parity.Items.AddRange(new object[] { "None", "Even", "Odd" });
        _icon.Items.AddRange(Icons);
        foreach (var c in new Control[] { _id, _name, _brand, _model, _note, _icon, _baud, _parity }) { if (c is TextBox t) Skin.Input(t); c.TextChanged += (_, _) => _dirty = true; }
        _baud.SelectedIndexChanged += (_, _) => _dirty = true; _parity.SelectedIndexChanged += (_, _) => _dirty = true;

        var head = new TableLayoutPanel { Dock = DockStyle.Top, Height = 118, ColumnCount = 8, Padding = new Padding(4) };
        for (var i = 0; i < 8; i++) head.ColumnStyles.Add(new ColumnStyle(i % 2 == 0 ? SizeType.Absolute : SizeType.Percent, i % 2 == 0 ? 110 : 25));
        void F(string label, Control c, int col, int row) { head.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 8, 0, 0) }, col, row); c.Dock = DockStyle.Fill; head.Controls.Add(c, col + 1, row); }
        F("Mã (id)", _id, 0, 0); F("Tên cho thợ", _name, 2, 0); F("Hãng", _brand, 4, 0); F("Model", _model, 6, 0);
        F("Biểu tượng", _icon, 0, 1); F("Baud mặc định", _baud, 2, 1); F("Parity", _parity, 4, 1); F("Ghi chú", _note, 6, 1);
        var hint = new Label { Text = Hint, Dock = DockStyle.Bottom, Height = 58, ForeColor = Theme.Muted, BackColor = Theme.Panel, Padding = new Padding(6) };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Theme.Bg, Padding = new Padding(8, 6, 8, 4), WrapContents = false };
        FlatButton Btn(string cap, int w, Func<Task> act, bool primary = false)
        {
            var b = new FlatButton { Caption = cap, Width = w, Primary = primary };
            b.Click += async (_, _) => await Guard(act);
            return b;
        }
        bar.Controls.Add(Btn("💾 Lưu lên server (Ctrl+S)", 230, SaveAsync, primary: true));
        bar.Controls.Add(Btn("＋ Mẫu mới", 120, () => { if (ConfirmLeave()) Show(null); return Task.CompletedTask; }));
        bar.Controls.Add(Btn("⧉ Nhân bản", 120, () => { var j = Build(false); if (j != null) { j["id"] = (j["id"]?.ToString() ?? "mau") + "-2"; Show(j); _dirty = true; } return Task.CompletedTask; }));
        bar.Controls.Add(Btn("✕ Xoá mẫu", 120, DeleteAsync));
        bar.Controls.Add(Btn("⇩ Nhập JSON", 130, () => { ImportJson(); return Task.CompletedTask; }));
        bar.Controls.Add(Btn("⇧ Xuất JSON", 130, () => { ExportJson(); return Task.CompletedTask; }));
        bar.Controls.Add(Btn("↻ Tải lại", 110, LoadAsync));

        var left = new Card { Title = "Mẫu trên server", Sub = "Xám = đã xoá (lưu lại để dùng lại)", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        left.Controls.Add(_list);
        var right = new Card { Title = "Bảng thanh ghi", Sub = "Mỗi dòng một thông số · thợ điện chỉ thấy tên + đơn vị", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        right.Controls.Add(_g); right.Controls.Add(hint); right.Controls.Add(head);
        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, BackColor = Theme.Bg, SplitterWidth = 6 };
        split.Panel1.Controls.Add(left); split.Panel2.Controls.Add(right);
        Controls.Add(split); Controls.Add(_status); Controls.Add(bar);
        Shown += async (_, _) => { split.SplitterDistance = 380; Show(null); await Guard(LoadAsync); };
        KeyDown += async (_, e) => { if (e.KeyCode == Keys.S && e.Control) { e.Handled = true; e.SuppressKeyPress = true; await Guard(SaveAsync); } };
        FormClosing += (_, e) => { if (!ConfirmLeave()) e.Cancel = true; };
    }

    void Text_(string n, string t, int w) { _g.Columns.Add(new DataGridViewTextBoxColumn { Name = n, HeaderText = t, Width = w }); }
    void Combo(string n, string t, string[] items, int w) { var c = new DataGridViewComboBoxColumn { Name = n, HeaderText = t, Width = w, FlatStyle = FlatStyle.Flat, DisplayStyle = DataGridViewComboBoxDisplayStyle.ComboBox }; c.Items.AddRange(items); _g.Columns.Add(c); }
    void Check(string n, string t, int w) { _g.Columns.Add(new DataGridViewCheckBoxColumn { Name = n, HeaderText = t, Width = w }); }
    void Status(string s, bool err = false) { _status.Text = s; _status.ForeColor = err ? Theme.Red : Theme.Muted; }
    bool ConfirmLeave() => !_dirty || MessageBox.Show(this, "Mẫu đang sửa chưa lưu lên server. Bỏ thay đổi?", "Thư viện thiết bị", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes;

    async Task Guard(Func<Task> act)
    {
        UseWaitCursor = true;
        try { await act(); }
        catch (Exception e) { Status(AdminApi.Explain(e), true); }
        finally { UseWaitCursor = false; }
    }

    async Task LoadAsync()
    {
        Status("Đang tải thư viện…");
        var root = JsonNode.Parse(await _api.TemplatesAsync())!.AsObject();
        _tpls = root["templates"]!.AsArray().Select(x => x!.AsObject()).ToList();
        _list.Rows.Clear();
        foreach (var t in _tpls)
        {
            var i = _list.Rows.Add(t["id"]?.ToString(), t["name"]?.ToString(), t["rev"]?.ToString());
            if (t["deleted"]?.GetValue<bool>() == true) _list.Rows[i].DefaultCellStyle.ForeColor = Theme.Muted;
        }
        Status($"{_tpls.Count(t => t["deleted"]?.GetValue<bool>() != true)} mẫu đang dùng. Kỹ thuật viên thấy thay đổi ngay khi mở lại danh sách trên điện thoại.");
    }

    static string S(JsonNode? n) => n?.ToString() ?? "";
    static string Num(double v) => v.ToString(CultureInfo.InvariantCulture);

    /// <summary>Đưa một mẫu lên form (null = mẫu trống).</summary>
    void Show(JsonObject? t)
    {
        _id.Text = S(t?["id"]); _name.Text = S(t?["name"]); _brand.Text = S(t?["brand"]); _model.Text = S(t?["model"]); _note.Text = S(t?["note"]);
        _icon.Text = t == null ? "dev" : S(t["icon"]);
        _baud.SelectedItem = t?["serial"]?["baud"]?.ToString() ?? "9600"; _parity.SelectedItem = t?["serial"]?["parity"]?.ToString() ?? "None";
        _id.ReadOnly = t?["rev"] != null;   // mẫu đã có trên server: đổi mã = mẫu khác (dùng Nhân bản)
        _g.Rows.Clear();
        var test = (t?["test"] as JsonArray)?.Select(x => x?.ToString()).ToHashSet() ?? new();
        foreach (var f in (t?["fields"] as JsonArray ?? new JsonArray()).Select(x => x!.AsObject()))
        {
            var addr = f["addr"]?.GetValue<int>() ?? 0;
            _g.Rows.Add(S(f["key"]), S(f["label"]), AccessNames[Math.Max(0, Array.IndexOf(AccessKeys, S(f["access"])))], (f["fc"]?.GetValue<int>() ?? 3) == 4 ? FcNames[1] : FcNames[0],
                addr >= 10 ? "0x" + addr.ToString("X4") : addr.ToString(), S(f["type"]) is { Length: > 0 } ty ? ty : "UInt16", S(f["order"]) is { Length: > 0 } o ? o : "AB",
                f["scale"] is { } sc ? Num(sc.GetValue<double>()) : "1", S(f["unit"]), KindNames[Math.Max(0, Array.IndexOf(KindKeys, S(f["kind"])))],
                f["min"] is { } mn ? Num(mn.GetValue<double>()) : "", f["max"] is { } mx ? Num(mx.GetValue<double>()) : "",
                f["show"]?.GetValue<bool>() != false, test.Contains(S(f["key"])), (f["wfc"]?.GetValue<int>() ?? 0) == 16, S(f["on"]), S(f["off"]));
        }
        _dirty = false;
        Status(t == null ? "Mẫu mới — điền mã (vd. invt-gd20), tên, rồi bảng thanh ghi." : $"Mẫu {S(t["id"])} · bản {S(t["rev"])} · sửa lần cuối bởi {S(t["updatedBy"])}");
    }

    static bool TryAddr(string s, out int v)
    {
        s = s.Trim().Replace("_", "");
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return int.TryParse(s[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
        if (s.EndsWith("h", StringComparison.OrdinalIgnoreCase)) return int.TryParse(s[..^1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
        return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
    }
    static bool TryD(string s, out double? v)
    {
        v = null; s = s.Trim().Replace(',', '.');
        if (s.Length == 0) return true;
        if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return false;
        v = d; return true;
    }

    /// <summary>Form → JSON đúng định dạng server (deviceLibrary.validateTemplate). strict = báo lỗi dòng (server vẫn kiểm lại).</summary>
    JsonObject? Build(bool strict = true)
    {
        _g.EndEdit();
        var fields = new JsonArray(); var test = new JsonArray();
        foreach (DataGridViewRow r in _g.Rows)
        {
            if (r.IsNewRow) continue;
            string C(string n) => Convert.ToString(r.Cells[n].Value)?.Trim() ?? "";
            bool B(string n) => r.Cells[n].Value is true;
            var key = C("key"); if (key.Length == 0 && C("label").Length == 0) continue;
            var line = $"Dòng {r.Index + 1}";
            if (!TryAddr(C("addr"), out var addr)) { if (strict) { Status($"{line}: địa chỉ phải là số (12288) hoặc hex (0x3000).", true); return null; } addr = 0; }
            if (addr >= 30001 && addr <= 49999 && strict && MessageBox.Show(this, $"{line}: địa chỉ {addr} trông như cách ghi 3xxxx/4xxxx của tài liệu. Địa chỉ PDU thường là {(addr >= 40001 ? addr - 40001 : addr - 30001)}. Vẫn giữ {addr}?", "Địa chỉ", MessageBoxButtons.YesNo) != DialogResult.Yes) return null;
            var okNum = TryD(C("scale"), out var sc) & TryD(C("min"), out var mn) & TryD(C("max"), out var mx);   // & (không tắt mạch): luôn gán cả ba
            if (!okNum && strict) { Status($"{line}: hệ số / Min / Max phải là số.", true); return null; }
            var f = new JsonObject
            {
                ["key"] = key, ["label"] = C("label"), ["access"] = AccessKeys[Math.Max(0, Array.IndexOf(AccessNames, C("access")))],
                ["fc"] = C("fc") == FcNames[1] ? 4 : 3, ["addr"] = addr, ["type"] = C("type").Length > 0 ? C("type") : "UInt16", ["order"] = C("order"),
                ["scale"] = sc ?? 1, ["unit"] = C("unit"), ["kind"] = KindKeys[Math.Max(0, Array.IndexOf(KindNames, C("kind")))], ["show"] = B("show"),
            };
            if (mn is { } a) f["min"] = a; if (mx is { } b) f["max"] = b;
            if (B("wfc")) f["wfc"] = 16;
            if (C("on").Length > 0) f["on"] = C("on"); if (C("off").Length > 0) f["off"] = C("off");
            if (B("test")) test.Add(key);
            fields.Add(f);
        }
        return new JsonObject
        {
            ["id"] = _id.Text.Trim().ToLowerInvariant(), ["name"] = _name.Text.Trim(), ["brand"] = _brand.Text.Trim(), ["model"] = _model.Text.Trim(),
            ["icon"] = _icon.Text.Trim(), ["note"] = _note.Text.Trim(),
            ["serial"] = new JsonObject { ["baud"] = int.TryParse(_baud.SelectedItem as string, out var bd) ? bd : 9600, ["parity"] = _parity.SelectedItem as string ?? "None" },
            ["test"] = test, ["fields"] = fields,
        };
    }

    async Task SaveAsync()
    {
        var j = Build(); if (j == null) return;
        var id = j["id"]!.ToString();
        if (id.Length == 0) { Status("Nhập mã mẫu (chữ thường, số, \"-\"), vd. invt-gd20.", true); return; }
        Status("Đang lưu…");
        var res = JsonNode.Parse(await _api.TemplatePutAsync(id, j.ToJsonString()))!.AsObject();
        _dirty = false;
        await LoadAsync();
        var saved = _tpls.FirstOrDefault(t => S(t["id"]) == id);
        if (saved != null) Show(saved);
        Status($"Đã lưu {id} (bản {S(res["rev"])}). Kỹ thuật viên mở lại danh sách trên điện thoại là thấy.");
    }

    async Task DeleteAsync()
    {
        var id = _id.Text.Trim();
        if (id.Length == 0 || MessageBox.Show(this, $"Xoá mẫu \"{id}\" khỏi danh sách của kỹ thuật viên?\nThiết bị đã lắp bằng mẫu này vẫn chạy bình thường. Lưu lại mẫu để dùng lại.", "Xoá mẫu", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        await _api.TemplateDeleteAsync(id);
        _dirty = false;
        await LoadAsync();
        Status($"Đã xoá {id}.");
    }

    void ImportJson()
    {
        if (!ConfirmLeave()) return;
        using var dlg = new OpenFileDialog { Filter = "Mẫu thiết bị (*.json)|*.json", InitialDirectory = SamplesDir() };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        try { Show(JsonNode.Parse(File.ReadAllText(dlg.FileName))!.AsObject().Also(o => o.Remove("rev"))); _dirty = true; Status("Đã nhập — kiểm tra lại theo tài liệu của hãng rồi Lưu lên server."); }
        catch (Exception e) { Status("File JSON hỏng: " + e.Message, true); }
    }

    void ExportJson()
    {
        var j = Build(false); if (j == null) return;
        using var dlg = new SaveFileDialog { Filter = "Mẫu thiết bị (*.json)|*.json", FileName = (j["id"]?.ToString() is { Length: > 0 } s ? s : "mau") + ".json" };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        File.WriteAllText(dlg.FileName, j.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        Status("Đã xuất " + dlg.FileName);
    }

    /// <summary>Mẫu khởi đầu đi kèm repo (tools/GatewayAdmin/templates) nếu chạy từ thư mục mã nguồn.</summary>
    static string SamplesDir()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "templates")) && File.Exists(Path.Combine(d.FullName, "GatewayAdmin.csproj"))) return Path.Combine(d.FullName, "templates");
        return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }
}

static class JsonExt
{
    public static T Also<T>(this T o, Action<T> a) { a(o); return o; }
}
