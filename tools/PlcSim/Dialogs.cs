using System.Globalization;
using System.Text.RegularExpressions;

namespace PlcSim;

/// <summary>Hỏi xác nhận trước khi xoá; mặc định chọn "Không". Override chỉ dùng trong --selftest.</summary>
static class Ask
{
    public static bool? Override;
    public static bool Yes(IWin32Window? owner, string text, string title) =>
        Override ?? MessageBox.Show(owner, text, title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
}

static class DlgUi
{
    public static Label L(string t) => new() { Text = t, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 8, 0) };

    public static TableLayoutPanel Table()
    {
        var t = new TableLayoutPanel { Dock = DockStyle.Top, ColumnCount = 2, Padding = new Padding(16, 12, 16, 0), AutoSize = true };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return t;
    }

    public static Label Row(TableLayoutPanel t, string label, Control c)
    {
        var l = L(label); var r = t.RowStyles.Count;   // đặt ô tường minh: control ẩn không làm lệch hàng
        c.Dock = DockStyle.Fill; c.Margin = new Padding(0, 3, 0, 3);
        t.Controls.Add(l, 0, r); t.Controls.Add(c, 1, r);
        t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        return l;
    }

    /// <summary>Tiêu đề nhóm (chiếm cả hai cột).</summary>
    public static Label Section(TableLayoutPanel t, string text)
    {
        var l = new Label { Text = text, AutoSize = true, Font = new Font("Segoe UI Semibold", 10f), ForeColor = Color.FromArgb(50, 116, 217), Margin = new Padding(0, 12, 0, 2) };
        t.Controls.Add(l, 0, t.RowStyles.Count); t.SetColumnSpan(l, 2);
        t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        return l;
    }

    public static NumericUpDown Dec(decimal min, decimal max, int places = 3) => new() { Minimum = min, Maximum = max, DecimalPlaces = places };

    /// <summary>
    /// Bố cục chung, co theo DPI/chữ: thân cuộn được (bảng + ghi chú tự xuống dòng), thanh lỗi + nút cố định ở đáy.
    /// Cửa sổ to vừa đủ nội dung, tối đa bằng vùng làm việc của màn hình (quá thì thân cuộn).
    /// </summary>
    public static Action<bool> Build(Form f, TableLayoutPanel t, Label[] notes, Label? err, Control bar)
    {
        var scroller = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var body = new TableLayoutPanel { Dock = DockStyle.Top, ColumnCount = 1, AutoSize = true };
        scroller.Controls.Add(body);
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        t.Dock = DockStyle.Fill; t.AutoSize = true; t.Margin = new Padding(0);
        body.RowStyles.Add(new RowStyle(SizeType.AutoSize)); body.Controls.Add(t);
        foreach (var n in notes)
        {
            n.Dock = DockStyle.Fill; n.AutoSize = true; n.Margin = new Padding(0, 2, 0, 4);
            body.RowStyles.Add(new RowStyle(SizeType.AutoSize)); body.Controls.Add(n);
        }
        void Wrap()
        {
            var w = Math.Max(100, scroller.ClientSize.Width - 4);
            foreach (var n in notes) n.MaximumSize = new Size(w, 0);
            if (err != null) err.MaximumSize = new Size(Math.Max(100, f.ClientSize.Width), 0);
        }
        scroller.SizeChanged += (_, _) => Wrap();
        if (err != null) { err.Dock = DockStyle.Bottom; err.AutoSize = true; err.Padding = new Padding(16, 4, 16, 4); }
        if (bar is FlowLayoutPanel) { bar.Dock = DockStyle.Bottom; bar.AutoSize = true; bar.Padding = new Padding(10, 8, 10, 8); }
        foreach (Control c in bar.Controls) if (c is Button bt) { bt.AutoSize = true; bt.AutoSizeMode = AutoSizeMode.GrowAndShrink; bt.Padding = new Padding(14, 3, 14, 3); bt.MinimumSize = new Size(f.LogicalToDeviceUnits(90), 0); bt.Margin = new Padding(6, 0, 6, 0); }
        f.Controls.Add(scroller);
        if (err != null) f.Controls.Add(err);
        f.Controls.Add(bar);
        void Fit(bool center)
        {
            var wa = Screen.FromControl(f).WorkingArea;
            var cw = f.LogicalToDeviceUnits(720);
            if (center) f.ClientSize = new Size(cw, 300);   // đặt bề rộng trước để chữ xuống dòng đúng rồi mới đo chiều cao
            f.PerformLayout(); Wrap();
            var w = cw - SystemInformation.VerticalScrollBarWidth;
            var need = body.GetPreferredSize(new Size(w, 0)).Height + bar.PreferredSize.Height + (err?.PreferredSize.Height ?? 0) + f.LogicalToDeviceUnits(30);
            f.ClientSize = new Size(cw, Math.Min(need, wa.Height - f.LogicalToDeviceUnits(90)));
            if (center) f.Location = new Point(wa.Left + Math.Max(0, (wa.Width - f.Width) / 2), wa.Top + Math.Max(0, (wa.Height - f.Height) / 2));
            else if (f.Bottom > wa.Bottom) f.Top = Math.Max(wa.Top, wa.Bottom - f.Height);
        }
        f.Load += (_, _) => Fit(true);
        return Fit;
    }

    public static Form Shell(string title, Size size)
    {
        return new Form
        {
            Text = title, FormBorderStyle = FormBorderStyle.Sizable, MaximizeBox = true, MinimizeBox = false,
            StartPosition = FormStartPosition.CenterParent, ClientSize = size, Font = new Font("Segoe UI", 9.5f),
        };
    }
}

/// <summary>Một thông số riêng của giao thức: khoá, nhãn, mặc định; Choices != null thì chọn từ danh sách.</summary>
sealed record PDef(string Key, string Label, string Default, string[]? Choices = null);

/// <summary>Thông số địa chỉ riêng của từng giao thức (lưu trong Param dạng "khoá=giá trị|khoá=giá trị").</summary>
static class ProtoParams
{
    public static string Group(string kind) => kind.StartsWith("fins") ? "fins" : kind;

    public static PDef[] Defs(string kind) => Group(kind) switch
    {
        // Khoá và lựa chọn KHỚP với Plciot.Scada.ProtocolSpec của gateway: gateway khai báo đúng các thông số này cho từng luồng.
        "modbus" => new PDef[] { new("unit", "Unit ID (slave)", "1") },
        "mc" => new PDef[] { new("plc", "Dòng PLC", "Q", new[] { "Q", "L", "QnA", "iQ-R", "iQ-L" }) },
        "fins" => new PDef[] { new("node", "Node đích (DA1)", "1"), new("srcnode", "Node nguồn (SA1)", "0") },
        "s7" => new PDef[] { new("cpu", "CPU", "S71500", new[] { "S7200", "S7300", "S7400", "S71200", "S71500" }), new("rack", "Rack", "0"), new("slot", "Slot", "1"), new("db", "Số DB", "1") },
        "eip" => new PDef[] { new("tag", "Tên tag (INT[])", "PLC_D"), new("slot", "Slot CPU", "0") },
        "opcua" => new PDef[] { new("ns", "Namespace index", "2"), new("image", "Node ảnh thanh ghi", "PLC_D"), new("prefix", "Tiền tố node ghi", "PLC_W") },
        "ads" => new PDef[] { new("netid", "AMS NetId", "127.0.0.1.1.1"), new("port", "AMS port", "851"), new("symbol", "Symbol (INT[])", "GVL_PLC.D") },
        "mqtt" => new PDef[] { new("qos", "QoS", "0", new[] { "0", "1", "2" }), new("retain", "Retain", "off", new[] { "off", "on" }) },
        _ => Array.Empty<PDef>(),
    };

    public static string Hint(string kind) => Group(kind) switch
    {
        "modbus" => "Modbus TCP: thanh ghi holding = D n; gateway khai báo cùng Unit ID.",
        "mc" => "Mitsubishi MC 3E (nhị phân): thiết bị D n; gateway khai báo cùng dòng PLC.",
        "fins" => "Omron FINS: vùng DM = ảnh D; gateway khai báo cùng node đích/nguồn.",
        "s7" => "Siemens S7: DBW(2n) của DB bất kỳ = D n; server nhận mọi số DB/rack/slot.",
        "eip" => "EtherNet/IP: mảng INT theo tên tag; tên tag của luồng đầu tiên được dùng khi khởi động.",
        "opcua" => "OPC UA: node ảnh ns=<ns>;s=PLC_D và các node ghi theo tiền tố + số thanh ghi.",
        "ads" => "Beckhoff ADS: AmsNetId/port/symbol mà gateway phải trỏ tới; symbol của luồng đầu tiên được dùng.",
        "mqtt" => "MQTT: gửi d.<thiết bị>.<field> lên broker của gateway; bỏ qua thanh ghi D và hệ số.",
        _ => "",
    };

    public static Dictionary<string, string> Parse(string kind, string param)
    {
        var defs = Defs(kind);
        var r = defs.ToDictionary(d => d.Key, d => d.Default);
        if (string.IsNullOrWhiteSpace(param) || defs.Length == 0) return r;
        if (!param.Contains('=')) { r[defs[0].Key] = param.Trim(); return r; }   // file cũ: một giá trị duy nhất
        foreach (var part in param.Split('|'))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && r.ContainsKey(kv[0])) r[kv[0]] = kv[1];
        }
        return r;
    }

    public static string Get(string param, string kind, string key) => Parse(kind, param).GetValueOrDefault(key, "");

    public static string Format(IEnumerable<(string Key, string Value)> kv) => string.Join("|", kv.Select(x => $"{x.Key}={x.Value}"));

    public static string Address(string kind, int a, string param, string child, string field)
    {
        var p = Parse(kind, param);
        return Group(kind) switch
        {
            "modbus" => $"Holding {40001 + a} (offset {a}), unit {p["unit"]}",
            "mc" => $"D{a}  ({p["plc"]}, MC 3E)",
            "fins" => $"DM{a}, node {p["node"]}←{p["srcnode"]}",
            "s7" => $"DB{p["db"]}.DBW{a * 2}  ({p["cpu"]}, rack {p["rack"]}, slot {p["slot"]})",
            "eip" => $"{p["tag"]}[{a}] (INT), slot {p["slot"]}",
            "opcua" => $"ns={p["ns"]};s={p["prefix"]}{a}  (ghi) · ns={p["ns"]};s={p["image"]}  (ảnh)",
            "ads" => $"{p["netid"]}:{p["port"]}  {p["symbol"]}[{a}]",
            "mqtt" => $"d.{child}.{field}  (QoS {p["qos"]}, retain {p["retain"]}; bỏ qua D)",
            _ => $"D{a}",
        };
    }
}

/// <summary>Một thành viên của struct: tên field, kiểu, hệ số, cách sinh giá trị.</summary>
sealed record StructMember(string Name, PlcModel.DataType Type, double Scale, PlcModel.Gen Gen, double Value);

/// <summary>Thêm / sửa một luồng dữ liệu: giao thức, quyền, thông số giao thức, thiết bị.field ↔ thanh ghi D + cách sinh giá trị.</summary>
sealed class StreamDialog : IDisposable
{
    readonly Form _f;
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly ComboBox _access = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly Dictionary<string, List<(PDef Def, Label Lbl, Control Ctl)>> _pc = new();
    readonly List<Label> _protoRows = new();
    Action<bool> _fit = _ => { };
    Label _addrLbl = null!, _scaleLbl = null!, _valueLbl = null!, _minLbl = null!, _maxLbl = null!, _periodLbl = null!, _stepLbl = null!;
    readonly Label _addrPreview = new() { AutoSize = false, ForeColor = Color.FromArgb(50, 116, 217), Padding = new Padding(16, 2, 16, 0) };
    readonly (string Label, string Kind)[] _protos;
    string _lastKind = "";
    static readonly PlcModel.Access[] Accesses = { PlcModel.Access.Read, PlcModel.Access.Write, PlcModel.Access.ReadWrite };
    static readonly string[] AccessNames = { "Chỉ đọc (PLC → gateway; gateway không ghi được)", "Chỉ ghi (gateway → PLC; giữ giá trị gateway ghi)", "Đọc và ghi" };
    // kiểu dữ liệu: các kiểu đơn + "Struct" (nhiều thành viên nằm liền nhau trong D, dùng chung giao thức/quyền)
    static readonly (PlcModel.DataType T, string Name)[] Types =
    {
        (PlcModel.DataType.UInt16, "UINT — 16-bit không dấu (1 word)"), (PlcModel.DataType.Int16, "INT — 16-bit có dấu (1 word)"), (PlcModel.DataType.Bool, "BOOL — 0/1 (1 word)"),
        (PlcModel.DataType.UInt32, "UDINT — 32-bit không dấu (2 word)"), (PlcModel.DataType.Int32, "DINT — 32-bit có dấu (2 word)"),
        (PlcModel.DataType.Float32, "REAL — float 32-bit (2 word)"), (PlcModel.DataType.Float64, "LREAL — float 64-bit (4 word)"),
    };
    static readonly string[] SwapNames = { "Word cao trước (AB CD)", "Word thấp trước (CD AB)" };
    readonly ComboBox _type = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly ComboBox _swap = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    Label _typeLbl = null!, _swapLbl = null!, _fieldLbl = null!, _modeLbl = null!, _simSec = null!, _memSec = null!;
    readonly Panel _memPanel = new() { Dock = DockStyle.Fill };
    readonly DataGridView _grid = new() { Dock = DockStyle.Fill, AllowUserToAddRows = false, RowHeadersVisible = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, SelectionMode = DataGridViewSelectionMode.CellSelect, BackgroundColor = SystemColors.Window };
    List<StructMember> _members = new();
    readonly ComboBox _child = new() { DropDownStyle = ComboBoxStyle.DropDown };
    readonly TextBox _field = new();
    readonly NumericUpDown _addr = new() { Minimum = 0, Maximum = PlcModel.Size - 1 };
    readonly NumericUpDown _scale = DlgUi.Dec(0.001m, 100000);
    readonly ComboBox _mode = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly NumericUpDown _value = DlgUi.Dec(-1_000_000, 1_000_000), _min = DlgUi.Dec(-1_000_000, 1_000_000), _max = DlgUi.Dec(-1_000_000, 1_000_000);
    readonly NumericUpDown _period = DlgUi.Dec(1, 86400, 1), _step = DlgUi.Dec(-100000, 100000);
    readonly Label _hint = new() { ForeColor = Color.DimGray, Padding = new Padding(16, 6, 16, 0) };
    readonly Label _err = new() { ForeColor = Color.Firebrick, Padding = new Padding(16, 0, 16, 0) };
    readonly HashSet<int> _used;
    readonly HashSet<(string, string)> _existing;
    readonly bool _edit;
    static readonly PlcModel.FieldMode[] Modes = { PlcModel.FieldMode.Fixed, PlcModel.FieldMode.Random, PlcModel.FieldMode.Sine, PlcModel.FieldMode.Ramp };
    static readonly string[] Names =
    {
        "Cố định (một số)", "Ngẫu nhiên trong khoảng Min–Max", "Sóng sin giữa Min–Max", "Tăng dần từ Min tới Max rồi quay lại"
    };

    /// <summary>Cửa sổ hộp thoại và ô thông số theo khoá (dùng cho chế độ trình diễn --autodemo).</summary>
    public Form Window => _f;
    public Control ParamControl(string key) => _pc[ProtoParams.Group(Kind)].First(x => x.Def.Key == key).Ctl;

    public string Child => _child.Text.Trim();
    public string Field => _field.Text.Trim();
    public bool IsStruct => _type.SelectedIndex == Types.Length;
    public PlcModel.DataType DType => IsStruct ? PlcModel.DataType.UInt16 : Types[Math.Max(0, _type.SelectedIndex)].T;
    public bool Swap => _swap.SelectedIndex == 1;
    public List<StructMember> Members => _members;
    public int Addr => (int)_addr.Value;
    public double Scale => (double)_scale.Value;
    public double Value => (double)_value.Value;
    public string Kind => _protos[Math.Max(0, _proto.SelectedIndex)].Kind;
    public PlcModel.Access AccessMode => Accesses[Math.Max(0, _access.SelectedIndex)];
    public string Param => ProtoParams.Format(_pc[ProtoParams.Group(Kind)].Select(x => (x.Def.Key, x.Ctl is ComboBox cb ? Convert.ToString(cb.SelectedItem) ?? x.Def.Default : x.Ctl.Text.Trim())));
    public PlcModel.Gen Gen => new(Modes[Math.Max(0, _mode.SelectedIndex)], (double)_min.Value, (double)_max.Value, (double)_period.Value, (double)_step.Value);

    public StreamDialog(string? child, string? field, int addr, double scale, PlcModel.Gen gen, double value, HashSet<int> used, string[] children, HashSet<(string, string)> existing, bool edit,
        (string Label, string Kind)[] protos, string kind, PlcModel.Access access, string param,
        PlcModel.DataType dtype = PlcModel.DataType.UInt16, bool swap = false, string group = "", List<StructMember>? members = null)
    {
        _used = used; _existing = existing; _edit = edit; _protos = protos;
        _f = DlgUi.Shell(edit ? (group.Length > 0 ? $"Sửa struct {child}.{group}" : $"Sửa luồng {child}.{field}") : "Thêm luồng dữ liệu", new Size(600, 740));
        foreach (var p in protos) _proto.Items.Add(p.Label);
        _access.Items.AddRange(AccessNames);
        _mode.Items.AddRange(Names);
        foreach (var ty in Types) _type.Items.Add(ty.Name);
        _type.Items.Add("STRUCT — nhiều thành viên");
        _swap.Items.AddRange(SwapNames);
        foreach (var c in children) _child.Items.Add(c);
        var t = DlgUi.Table();
        DlgUi.Section(t, "Thiết bị và quyền");
        DlgUi.Row(t, "Thiết bị (child)", _child);
        _fieldLbl = DlgUi.Row(t, "Field", _field);
        DlgUi.Row(t, "Quyền truy cập", _access);
        DlgUi.Section(t, "Kiểu dữ liệu");
        _typeLbl = DlgUi.Row(t, "Kiểu dữ liệu", _type);
        _swapLbl = DlgUi.Row(t, "Thứ tự word (kiểu ≥ 32-bit)", _swap);
        _memSec = DlgUi.Section(t, "Thành viên của struct (nằm liền nhau từ thanh ghi D bắt đầu)");
        BuildMembers(t);
        DlgUi.Section(t, "Giao thức và địa chỉ");
        DlgUi.Row(t, "Giao thức", _proto);
        _addrLbl = DlgUi.Row(t, "Thanh ghi D", _addr);
        _scaleLbl = DlgUi.Row(t, "Hệ số (D = giá trị × hệ số)", _scale);
        // mỗi nhóm giao thức có bộ thông số riêng; chỉ nhóm đang chọn được hiện
        foreach (var grp in protos.Select(p => ProtoParams.Group(p.Kind)).Distinct())
        {
            var list = new List<(PDef, Label, Control)>();
            foreach (var d in ProtoParams.Defs(grp))
            {
                Control c;
                if (d.Choices != null) { var cb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList }; cb.Items.AddRange(d.Choices); c = cb; cb.SelectedIndexChanged += (_, _) => UpdateState(); }
                else { var tb = new TextBox(); c = tb; tb.TextChanged += (_, _) => UpdateState(); }
                list.Add((d, DlgUi.Row(t, d.Label, c), c));
            }
            _pc[grp] = list;
        }
        _simSec = DlgUi.Section(t, "Giả lập giá trị");
        _modeLbl = DlgUi.Row(t, "Cách sinh giá trị", _mode);
        _valueLbl = DlgUi.Row(t, "Giá trị cố định / ban đầu", _value);
        _minLbl = DlgUi.Row(t, "Min", _min);
        _maxLbl = DlgUi.Row(t, "Max", _max);
        _periodLbl = DlgUi.Row(t, "Chu kỳ sóng sin (giây)", _period);
        _stepLbl = DlgUi.Row(t, "Bước tăng mỗi giây", _step);
_hint.Text = "";
        var ok = new Button { Text = edit ? "Lưu" : "Thêm", Width = 100, Height = 32, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "Huỷ", Width = 90, Height = 32, DialogResult = DialogResult.Cancel };
        ok.Click += (_, _) => Commit();
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10, 8, 10, 0) };
        bar.Controls.Add(cancel); bar.Controls.Add(ok);
        _fit = DlgUi.Build(_f, t, new[] { _addrPreview, _hint }, _err, bar);
        _f.CancelButton = cancel;

        _proto.SelectedIndex = Math.Max(0, Array.FindIndex(protos, p => p.Kind == kind));
        _access.SelectedIndex = Math.Max(0, Array.IndexOf(Accesses, access));
        _lastKind = Kind;
        foreach (var (grp, list) in _pc)
        {
            var vals = ProtoParams.Parse(list.Count > 0 ? protos.First(p => ProtoParams.Group(p.Kind) == grp).Kind : grp, grp == ProtoParams.Group(Kind) ? param : "");
            foreach (var (d, _, c) in list)
                if (c is ComboBox cb) { var i = Array.IndexOf(d.Choices!, vals[d.Key]); cb.SelectedIndex = i >= 0 ? i : 0; } else c.Text = vals[d.Key];
        }
        _child.Text = child ?? ""; _field.Text = group.Length > 0 ? group : field ?? "";
        _swap.SelectedIndex = swap ? 1 : 0;
        if (group.Length > 0) { _type.SelectedIndex = Types.Length; foreach (var m in members ?? new()) AddMember(m); }
        else
        {
            _type.SelectedIndex = Math.Max(0, Array.FindIndex(Types, x => x.T == dtype));
            if (edit) _type.Items.RemoveAt(Types.Length);      // sửa luồng đơn: không đổi thành struct
        }
        if (edit) { _child.Enabled = false; _field.Enabled = false; if (group.Length > 0) _type.Enabled = false; }
        _addr.Value = addr >= 0 ? addr : NextFree();
        _scale.Value = (decimal)Math.Clamp(scale, 0.001, 100000);
        _mode.SelectedIndex = Math.Max(0, Array.IndexOf(Modes, gen.Mode));
        _value.Value = (decimal)Math.Clamp(value, -1_000_000, 1_000_000);
        _min.Value = (decimal)Math.Clamp(gen.Min, -1_000_000, 1_000_000); _max.Value = (decimal)Math.Clamp(gen.Max, -1_000_000, 1_000_000);
        _period.Value = (decimal)Math.Clamp(gen.Period, 1, 86400); _step.Value = (decimal)Math.Clamp(gen.Step, -100000, 100000);
        _mode.SelectedIndexChanged += (_, _) => UpdateState();
        _proto.SelectedIndexChanged += (_, _) => UpdateState();
        _access.SelectedIndexChanged += (_, _) => UpdateState();
        _addr.ValueChanged += (_, _) => UpdateState();
        _child.TextChanged += (_, _) => UpdateState();
        _field.TextChanged += (_, _) => UpdateState();
        _type.SelectedIndexChanged += (_, _) => { if (IsStruct && _grid.Rows.Count == 0) AddMember(new StructMember("m1", PlcModel.DataType.UInt16, 1, new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), 0)); UpdateState(); };
        _swap.SelectedIndexChanged += (_, _) => UpdateState();
        if (IsStruct && _grid.Rows.Count == 0) AddMember(new StructMember("m1", PlcModel.DataType.UInt16, 1, new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), 0));
        UpdateState();
    }

    int NextFree() { var n = 50; while (_used.Contains(n) && n < PlcModel.Size - 1) n++; return n; }

    // ---- bảng thành viên struct ------------------------------------------------------------------
    static readonly string[] TypeShort = { "UINT", "INT", "BOOL", "UDINT", "DINT", "REAL", "LREAL" };

    void BuildMembers(TableLayoutPanel t)
    {
        var tc = new DataGridViewComboBoxColumn { HeaderText = "Kiểu", FillWeight = 12, FlatStyle = FlatStyle.Flat }; tc.Items.AddRange(TypeShort);
        var mc = new DataGridViewComboBoxColumn { HeaderText = "Cách sinh", FillWeight = 20, FlatStyle = FlatStyle.Flat }; mc.Items.AddRange("Cố định", "Ngẫu nhiên", "Sóng sin", "Tăng dần");
        _grid.Columns.AddRange(
            new DataGridViewTextBoxColumn { HeaderText = "Tên", FillWeight = 16 }, tc,
            new DataGridViewTextBoxColumn { HeaderText = "Hệ số", FillWeight = 9 }, mc,
            new DataGridViewTextBoxColumn { HeaderText = "Giá trị / Min", FillWeight = 11 }, new DataGridViewTextBoxColumn { HeaderText = "Max", FillWeight = 9 },
            new DataGridViewTextBoxColumn { HeaderText = "Chu kỳ (s)", FillWeight = 9 }, new DataGridViewTextBoxColumn { HeaderText = "Bước/s", FillWeight = 9 },
            new DataGridViewTextBoxColumn { HeaderText = "D", FillWeight = 12, ReadOnly = true });
        _grid.DataError += (_, e) => e.ThrowException = false;
        _grid.CellValueChanged += (_, _) => { Recalc(); UpdateState(); };
        _grid.CurrentCellDirtyStateChanged += (_, _) => { if (_grid.IsCurrentCellDirty) _grid.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        var add = new Button { Text = "＋ Thêm thành viên", AutoSize = true };
        var del = new Button { Text = "Xoá thành viên", AutoSize = true };
        add.Click += (_, _) => AddMember(new StructMember($"m{_grid.Rows.Count + 1}", PlcModel.DataType.UInt16, 1, new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), 0));
        del.Click += (_, _) => { if (_grid.CurrentRow != null && _grid.Rows.Count > 1) { _grid.Rows.Remove(_grid.CurrentRow); Recalc(); UpdateState(); } };
        var btns = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(0, 4, 0, 0) };
        btns.Controls.Add(add); btns.Controls.Add(del);
        _memPanel.Controls.Add(_grid); _memPanel.Controls.Add(btns);
        _memPanel.Height = _f.LogicalToDeviceUnits(260); _memPanel.Margin = new Padding(0, 0, 0, 6);
        var r = t.RowStyles.Count;
        t.Controls.Add(_memPanel, 0, r); t.SetColumnSpan(_memPanel, 2); t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    }

    static string Num(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);

    void AddMember(StructMember m)
    {
        var i = _grid.Rows.Add(m.Name, TypeShort[Array.FindIndex(Types, x => x.T == m.Type)], Num(m.Scale), new[] { "Cố định", "Ngẫu nhiên", "Sóng sin", "Tăng dần" }[Math.Max(0, Array.IndexOf(Modes, m.Gen.Mode))],
            Num(m.Gen.Mode == PlcModel.FieldMode.Fixed ? m.Value : m.Gen.Min), Num(m.Gen.Max), Num(m.Gen.Period), Num(m.Gen.Step), "");
        Recalc();
    }

    static bool Parse(object? o, out double d)
        => double.TryParse((Convert.ToString(o) ?? "").Trim().Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out d);

    PlcModel.DataType MemberType(DataGridViewRow r)
    {
        var i = Array.IndexOf(TypeShort, Convert.ToString(r.Cells[1].Value));
        return Types[Math.Max(0, i)].T;
    }

    /// <summary>Cập nhật cột D (địa chỉ từng thành viên) theo thanh ghi bắt đầu và kiểu từng thành viên.</summary>
    int Recalc()
    {
        var a = (int)_addr.Value;
        foreach (DataGridViewRow r in _grid.Rows)
        {
            var w = PlcModel.Words(MemberType(r));
            r.Cells[8].Value = w == 1 ? $"D{a}" : $"D{a}–{a + w - 1}";
            a += w;
        }
        return a - (int)_addr.Value;
    }

    string? ParseMembers()
    {
        var list = new List<StructMember>(); var names = new HashSet<string>();
        var rx = new Regex("^[A-Za-z0-9_-]{1,48}$");
        foreach (DataGridViewRow r in _grid.Rows)
        {
            var n = (Convert.ToString(r.Cells[0].Value) ?? "").Trim();
            if (!rx.IsMatch(n)) return $"Tên thành viên \"{n}\": chỉ chữ, số, _ và -, tối đa 48 ký tự.";
            if (!names.Add(n)) return $"Thành viên \"{n}\" bị trùng tên.";
            if (!Parse(r.Cells[2].Value, out var sc) || sc <= 0) return $"{n}: hệ số phải là số > 0.";
            var mi = new[] { "Cố định", "Ngẫu nhiên", "Sóng sin", "Tăng dần" }.ToList().IndexOf(Convert.ToString(r.Cells[3].Value) ?? "");
            var mode = Modes[Math.Max(0, mi)];
            if (AccessMode == PlcModel.Access.Write) mode = PlcModel.FieldMode.Fixed;   // chỉ ghi: không sinh giả lập
            if (!Parse(r.Cells[4].Value, out var v1)) return $"{n}: \"Giá trị / Min\" phải là số.";
            double max = v1, period = 60, step = 1;
            if (mode != PlcModel.FieldMode.Fixed)
            {
                if (!Parse(r.Cells[5].Value, out max)) return $"{n}: Max phải là số.";
                if (v1 > max) return $"{n}: Min không được lớn hơn Max.";
            }
            if (mode == PlcModel.FieldMode.Sine && (!Parse(r.Cells[6].Value, out period) || period <= 0)) return $"{n}: chu kỳ sóng sin phải > 0.";
            if (mode == PlcModel.FieldMode.Ramp && !Parse(r.Cells[7].Value, out step)) return $"{n}: bước tăng phải là số.";
            list.Add(new StructMember(n, MemberType(r), sc, new PlcModel.Gen(mode, v1, max, period, step), v1));
        }
        if (list.Count == 0) return "Struct cần ít nhất một thành viên.";
        _members = list;
        return null;
    }

    int WordsNeeded => IsStruct ? Recalc() : PlcModel.Words(DType);

    void UpdateState()
    {
        var kind = Kind;
        var grp = ProtoParams.Group(kind);
        var st = IsStruct;
        foreach (var (g, list) in _pc) foreach (var (_, l, c) in list) l.Visible = c.Visible = g == grp;
        var mqtt = kind == "mqtt";
        _fieldLbl.Text = st ? "Tên struct" : "Field";
        _swapLbl.Visible = _swap.Visible = st || PlcModel.Words(DType) > 1;
        _memSec.Visible = _memPanel.Visible = st;
        _addrLbl.Text = st ? "Thanh ghi D bắt đầu" : "Thanh ghi D";
        _addrLbl.Visible = _addr.Visible = !mqtt;   // MQTT gửi d.<child>.<field>, không dùng thanh ghi D
        _scaleLbl.Visible = _scale.Visible = !mqtt && !st;
        _modeLbl.Visible = _mode.Visible = _simSec.Visible = !st;
        _hint.Text = ProtoParams.Hint(kind) + "  Chỉ đọc: gateway ghi vào bị từ chối. Chỉ ghi: không sinh giả lập. Child/field phải trùng tem trên server nếu dùng cloud."
            + (st ? "  Struct: mỗi thành viên là một field của thiết bị, nằm liền nhau trong D; kiểu 32/64-bit chiếm 2/4 word." : "");
        var words = WordsNeeded;
        var range = words <= 1 ? $"D{Addr}" : $"D{Addr}–D{Addr + words - 1} ({words} word)";
        _addrPreview.Text = st ? $"Struct {Field} chiếm {range}.  Địa chỉ gateway: {ProtoParams.Address(kind, Addr, Param, Child, Field)} …"
                               : "Gateway dùng địa chỉ:  " + ProtoParams.Address(kind, Addr, Param, Child, Field) + (words > 1 ? $"  [{range}]" : "");

        // chỉ ghi: giá trị do gateway ghi vào, không sinh giả lập
        var writeOnly = AccessMode == PlcModel.Access.Write;
        if (writeOnly && _mode.SelectedIndex != 0) { _mode.SelectedIndex = 0; return; }
        _mode.Enabled = !writeOnly;
        var m = Modes[Math.Max(0, _mode.SelectedIndex)];
        _valueLbl.Visible = _value.Visible = !st && m == PlcModel.FieldMode.Fixed;
        var rng = m is PlcModel.FieldMode.Random or PlcModel.FieldMode.Sine or PlcModel.FieldMode.Ramp;
        _minLbl.Visible = _maxLbl.Visible = _min.Visible = _max.Visible = !st && rng;
        _periodLbl.Visible = _period.Visible = !st && m == PlcModel.FieldMode.Sine;
        _stepLbl.Visible = _step.Visible = !st && m == PlcModel.FieldMode.Ramp;
        if (_f.Visible) _fit(false);
    }

    void Commit()
    {
        foreach (var (d, _, c) in _pc[ProtoParams.Group(Kind)])
            if (c is TextBox tb && !Regex.IsMatch(tb.Text.Trim(), @"^[A-Za-z0-9_.:-]{1,64}$")) { _err.Text = $"{d.Label}: chỉ chữ, số và _ . : -, tối đa 64 ký tự."; return; }
        var rx = new Regex("^[A-Za-z0-9_-]{1,48}$");
        if (!rx.IsMatch(Child) || !rx.IsMatch(Field)) { _err.Text = IsStruct ? "Thiết bị/tên struct chỉ gồm chữ, số, _ và -, tối đa 48 ký tự." : "Thiết bị/field chỉ gồm chữ, số, _ và -, tối đa 48 ký tự."; return; }
        var words = WordsNeeded;
        if (Addr + words > PlcModel.Size) { _err.Text = $"D{Addr} + {words} word vượt quá D{PlcModel.Size - 1}."; return; }
        if (Kind != "mqtt")
            for (var i = 0; i < words; i++)
                if (_used.Contains(Addr + i)) { _err.Text = $"D{Addr + i} đã được luồng khác dùng (cần {words} word từ D{Addr})."; return; }
        if (IsStruct)
        {
            var e = ParseMembers();
            if (e != null) { _err.Text = e; return; }
            if (!_edit && _members.Any(m => _existing.Contains((Child, m.Name)))) { _err.Text = $"Thiết bị {Child} đã có field trùng tên thành viên."; return; }
        }
        else
        {
            if (!_edit && _existing.Contains((Child, Field))) { _err.Text = "Luồng này đã có."; return; }
            var g = Gen;
            if (g.Mode is PlcModel.FieldMode.Random or PlcModel.FieldMode.Sine or PlcModel.FieldMode.Ramp && g.Min > g.Max) { _err.Text = "Min không được lớn hơn Max."; return; }
        }
        _f.DialogResult = DialogResult.OK; _f.Close();
    }

    public DialogResult ShowDialog(IWin32Window owner) => _f.ShowDialog(owner);
    public void Dispose() => _f.Dispose();
}

/// <summary>Thông số kết nối của một giao thức (cổng, địa chỉ nghe, MQTT…). Mỗi giao thức có một bộ riêng.</summary>
public sealed class ProtoCfg
{
    public string Host { get; set; } = "0.0.0.0";
    public int Port { get; set; }
    public string Site { get; set; } = "factory1";
    public string Device { get; set; } = "plc01";
    public string User { get; set; } = "gw";
    public string Pass { get; set; } = "";
    public string Tag { get; set; } = "";
    public int Interval { get; set; } = 1000;
    public ProtoCfg Clone() => (ProtoCfg)MemberwiseClone();
}

/// <summary>Sửa thông số kết nối cho từng giao thức; giao thức nào có luồng dữ liệu thì được bật khi bấm Bắt đầu.</summary>
sealed class ProtocolDialog : IDisposable
{
    readonly Form _f;
    readonly (string Label, string Kind, int Port, string HostLabel, string Hint)[] _protos;
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TextBox _host = new(), _site = new(), _device = new(), _user = new(), _pass = new() { UseSystemPasswordChar = true }, _tag = new();
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535 };
    readonly NumericUpDown _interval = new() { Minimum = 200, Maximum = 600000, Increment = 100 };
    Label _hostLbl = null!; readonly Label _hint = new() { ForeColor = Color.DimGray, Padding = new Padding(16, 6, 16, 0) };
    readonly List<Control> _mqttOnly = new(), _tagOnly = new();
    readonly Dictionary<string, ProtoCfg> _cfg;
    int _cur = -1;

    public Dictionary<string, ProtoCfg> Result => _cfg;

    public ProtocolDialog((string Label, string Kind, int Port, string HostLabel, string Hint)[] protos, int idx, Dictionary<string, ProtoCfg> cfg)
    {
        _protos = protos;
        _cfg = cfg.ToDictionary(kv => kv.Key, kv => kv.Value.Clone());
        _f = DlgUi.Shell("Kết nối từng giao thức", new Size(600, 560));
        foreach (var p in protos) _proto.Items.Add(p.Label);
        var t = DlgUi.Table();
        DlgUi.Row(t, "Giao thức", _proto);
        _hostLbl = DlgUi.Row(t, "Địa chỉ", _host);
        DlgUi.Row(t, "Cổng", _port);
        void Mq(string label, Control c) { var l = DlgUi.Row(t, label, c); _mqttOnly.Add(l); _mqttOnly.Add(c); }
        Mq("Site (MQTT)", _site); Mq("Device (MQTT)", _device); Mq("MQTT user", _user); Mq("MQTT password", _pass); Mq("Chu kỳ gửi (ms)", _interval);
        var tl = DlgUi.Row(t, "Tên tag / symbol mặc định", _tag);
        _tagOnly.Add(tl); _tagOnly.Add(_tag);

        var note = new Label
        {
            Text = "Mỗi luồng dữ liệu chọn giao thức của nó; khi bấm Bắt đầu, simulator mở một máy chủ cho mỗi giao thức đang có luồng. Chọn giao thức ở trên rồi sửa thông số kết nối của giao thức đó.",
            ForeColor = Color.DimGray, Padding = new Padding(16, 0, 16, 0),
        };
        var ok = new Button { Text = "Lưu", Width = 100, Height = 32, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Huỷ", Width = 90, Height = 32, DialogResult = DialogResult.Cancel };
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10, 8, 10, 0) };
        bar.Controls.Add(cancel); bar.Controls.Add(ok);
        DlgUi.Build(_f, t, new[] { _hint, note }, null, bar);
        _f.AcceptButton = ok; _f.CancelButton = cancel;
        _f.FormClosing += (_, _) => Store();

        _proto.SelectedIndexChanged += (_, _) => Load();
        _proto.SelectedIndex = Math.Clamp(idx, 0, protos.Length - 1);
    }

    void Store()
    {
        if (_cur < 0) return;
        _cfg[_protos[_cur].Kind] = new ProtoCfg
        {
            Host = _host.Text.Trim(), Port = (int)_port.Value, Site = _site.Text.Trim(), Device = _device.Text.Trim(),
            User = _user.Text.Trim(), Pass = _pass.Text, Tag = _tag.Text.Trim(), Interval = (int)_interval.Value,
        };
    }

    void Load()
    {
        Store();
        _cur = _proto.SelectedIndex;
        var p = _protos[_cur];
        var c = _cfg.TryGetValue(p.Kind, out var x) ? x : new ProtoCfg { Port = p.Port, Host = p.Kind == "mqtt" ? "127.0.0.1" : "0.0.0.0" };
        _hostLbl.Text = p.HostLabel; _hint.Text = p.Hint;
        _host.Text = c.Host; _port.Value = Math.Clamp(c.Port <= 0 ? p.Port : c.Port, 1, 65535); _site.Text = c.Site; _device.Text = c.Device;
        _user.Text = c.User; _pass.Text = c.Pass; _tag.Text = c.Tag; _interval.Value = Math.Clamp(c.Interval, 200, 600000);
        foreach (var m in _mqttOnly) m.Visible = p.Kind == "mqtt";
        foreach (var m in _tagOnly) m.Visible = p.Kind is "eip" or "ads";
        if (_tag.Text.Length == 0) _tag.Text = p.Kind == "ads" ? "GVL_PLC.D" : p.Kind == "eip" ? "PLC_D" : "";
    }

    public DialogResult ShowDialog(IWin32Window owner) => _f.ShowDialog(owner);
    public void Dispose() => _f.Dispose();
}
