using System.Globalization;
using System.Text.RegularExpressions;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Ô chọn loại thiết bị vật lý.</summary>
sealed class TemplateTile : Painted
{
    bool _hot;
    public DeviceTemplate Tpl { get; }
    public bool Selected { get; set; }
    public TemplateTile(DeviceTemplate t) { Tpl = t; Size = new Size(262, 58); Margin = new Padding(0, 0, 0, 8); Cursor = Cursors.Hand; }
    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        g.Clear(Theme.Bg);
        using var path = Theme.Round(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 9);
        using (var b = new SolidBrush(Selected ? Color.FromArgb(40, Theme.Accent) : _hot ? Theme.Panel2 : Theme.Panel)) g.FillPath(b, path);
        using (var p = new Pen(Selected ? Theme.Accent : Theme.Border, Selected ? 1.6f : 1f)) g.DrawPath(p, path);
        var ic = new RectangleF(10, 9, 40, 40);
        using (var ip = Theme.Round(ic, 9)) { using var b = new SolidBrush(Color.FromArgb(50, Theme.Teal)); g.FillPath(b, ip); }
        TextRenderer.DrawText(g, Tpl.Icon, new Font("Segoe UI Symbol", 13f), Rectangle.Round(ic), Theme.Teal, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Tpl.Name, Theme.Semi, new Rectangle(60, 8, Width - 66, 22), Theme.Text, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        TextRenderer.DrawText(g, Tpl.Desc, Theme.Small, new Rectangle(60, 31, Width - 66, 20), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>
/// Thêm / sửa MỘT thiết bị ngoại vi: chọn loại thiết bị vật lý (có sẵn nhãn, đơn vị, chữ trạng thái đúng loại) rồi chỉnh đầy đủ từng field
/// (thanh ghi D, hệ số, giới hạn, kiểu hiển thị, chữ Bật/Tắt, ngưỡng cảnh báo). Kết quả là Pack + metadata hiển thị.
/// </summary>
sealed class DeviceDialog : Form
{
    readonly IGatewayApp _app;
    readonly string? _edit;
    readonly List<TemplateTile> _tiles = new();
    readonly TextBox _child = new(), _title = new();
    readonly DataGridView _g = new() { Dock = DockStyle.Fill };
    readonly Label _err = new() { ForeColor = Theme.Red, AutoSize = false, Height = 22, Font = Theme.Small, Dock = DockStyle.Bottom };
    DeviceTemplate _tpl = DeviceTemplate.All[1];
    bool _childTouched;

    const int ColField = 0, ColTitle = 1, ColAccess = 2, ColType = 3, ColD = 4, ColScale = 5, ColUnit = 6, ColMin = 7, ColMax = 8, ColKind = 9, ColOn = 10, ColOff = 11, ColLow = 12, ColHigh = 13;

    // Kết nối + thông số giao thức + thứ tự word: khai báo rõ cho thiết bị, không có giá trị ngầm định (ô gợi ý có thể sửa)
    static readonly string[] AccessNames = { "Chỉ đọc", "Chỉ ghi", "Đọc/ghi" };
    static readonly string[] TypeNames = { "UINT", "INT", "BOOL", "UDINT", "DINT", "REAL", "LREAL" };    // theo thứ tự PlcDataType
    static readonly string[] SwapNames = { "Word cao trước (AB CD)", "Word thấp trước (CD AB)" };
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly ComboBox _swap = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly FlowLayoutPanel _rowConn = new() { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
    readonly FlowLayoutPanel _rowParam = new() { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
    readonly Dictionary<string, Control> _connInputs = new(), _paramInputs = new();
    readonly Label _addrHint = new() { ForeColor = Theme.Accent, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 22 };

    /// <summary>Chế độ trình diễn (--autodemo): kịch bản chạy khi hộp thoại hiện.</summary>
    internal static Action<Form>? Hook;

    /// <summary>Thiết bị vừa bị xoá bằng nút trong hộp thoại sửa.</summary>
    public bool Deleted { get; private set; }

    /// <summary>Hỏi xác nhận xoá: nêu tên thiết bị, số field và hậu quả.</summary>
    public static bool ConfirmDelete(IGatewayApp app, IWin32Window? owner, string child)
    {
        var n = app.Config.Pack.Count(p => p.Child == child);
        var title = app.Meta.Device(child)?.Title;
        var name = string.IsNullOrWhiteSpace(title) ? child : $"{title} ({child})";
        return Ask.Yes(owner, $"Xoá thiết bị \"{name}\" cùng {n} field của nó?\n\nThẻ trên Tổng quan biến mất và gateway ngừng đọc/gửi các field này (kể cả lên cloud). Thao tác không hoàn tác được.", "Xác nhận xoá thiết bị");
    }

    /// <summary>Gỡ thiết bị khỏi cấu hình và metadata hiển thị.</summary>
    public static void Remove(IGatewayApp app, string child)
    {
        foreach (var p in app.Config.Pack.Where(x => x.Child == child).ToList()) { app.Config.Pack.Remove(p); app.Meta.Remove(child, p.Field); }
        app.Meta.RemoveDevice(child);
    }

    DeviceDialog(IGatewayApp app, string? edit)
    {
        _app = app; _edit = edit;
        Text = edit == null ? "Thêm thiết bị ngoại vi" : $"Sửa thiết bị {edit}";
        FormBorderStyle = FormBorderStyle.Sizable; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(1400, 820); MinimumSize = new Size(1150, 700);

        // ----- trái: loại thiết bị
        var left = new Panel { Dock = DockStyle.Left, Width = 292, Padding = new Padding(14, 12, 6, 8), BackColor = Theme.Bg };
        var lh = new Label { Text = "1. Loại thiết bị vật lý", ForeColor = Theme.Text, Font = Theme.Title, AutoSize = false, Dock = DockStyle.Top, Height = 30 };
        var list = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Theme.Bg };
        foreach (var t in DeviceTemplate.All)
        {
            var tile = new TemplateTile(t);
            tile.Click += (_, _) => { if (_edit == null) PickTemplate(t, true); };
            _tiles.Add(tile); list.Controls.Add(tile);
        }
        left.Controls.Add(list); left.Controls.Add(lh);
        if (edit != null) left.Visible = false;

        // ----- phải: thông số
        var right = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 12, 16, 8), BackColor = Theme.Bg };
        var rh = new Label { Text = edit == null ? "2. Thông số thiết bị" : "Thông số thiết bị", ForeColor = Theme.Text, Font = Theme.Title, AutoSize = false, Dock = DockStyle.Top, Height = 30 };
        Skin.Input(_child); Skin.Input(_title);
        var top = new TableLayoutPanel { Dock = DockStyle.Top, Height = 44, ColumnCount = 4, BackColor = Theme.Bg };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
        top.Controls.Add(Skin.Lbl("Mã thiết bị (child)")); _child.Dock = DockStyle.Fill; _child.Margin = new Padding(0, 6, 12, 6); top.Controls.Add(_child);
        top.Controls.Add(Skin.Lbl("Tên hiển thị")); _title.Dock = DockStyle.Fill; _title.Margin = new Padding(0, 6, 0, 6); top.Controls.Add(_title);
        _child.TextChanged += (_, _) => { if (_child.Focused) _childTouched = true; };
        if (edit != null) _child.Enabled = false;

        var hint = new Label
        {
            Text = "Mọi thông số khai báo rõ ở đây — gateway không tự ngầm định. Quyền: chỉ đọc (PLC → gateway), chỉ ghi, hoặc đọc/ghi. Kiểu: UDINT/DINT/REAL chiếm 2 word, LREAL 4 word (D kế tiếp tự tính). " +
                   "Min/Max = khoảng cho phép GHI (thanh trượt cũng dùng khoảng này). Kết nối dùng chung cho mọi thiết bị cùng giao thức.",
            ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 40,
        };
        var rowProto = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
        foreach (var src in ProtocolSpec.Streamable) _proto.Items.Add(ProtocolSpec.Name(src));
        _swap.Items.AddRange(SwapNames); _swap.SelectedIndex = 0;
        Skin.Input(_proto); Skin.Input(_swap);
        rowProto.Controls.Add(Field("Giao thức", _proto, 250)); rowProto.Controls.Add(Field("Thứ tự word (kiểu ≥ 32-bit)", _swap, 230));
        _proto.SelectedIndexChanged += (_, _) => RebuildBind(null, null);
        BuildGrid();

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.RightToLeft, BackColor = Theme.Bg, Padding = new Padding(0, 8, 0, 0) };
        var ok = new FlatButton { Caption = edit == null ? "Thêm thiết bị" : "Lưu thay đổi", Primary = true, Width = 160 };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 100 };
        ok.Click += (_, _) => Commit();
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        buttons.Controls.Add(ok); buttons.Controls.Add(cancel);
        if (edit != null)
        {
            var del = new FlatButton { Caption = "Xoá thiết bị", Danger = true, Width = 130 };
            del.Margin = new Padding(40, 0, 0, 0);
            del.Click += (_, _) =>
            {
                if (!ConfirmDelete(_app, this, edit)) return;
                Remove(_app, edit); Deleted = true;
                DialogResult = DialogResult.OK; Close();
            };
            buttons.Controls.Add(del);
        }

        right.Controls.Add(_g); right.Controls.Add(_err); right.Controls.Add(buttons); right.Controls.Add(hint); right.Controls.Add(_addrHint);
        right.Controls.Add(_rowParam); right.Controls.Add(_rowConn); right.Controls.Add(rowProto); right.Controls.Add(top); right.Controls.Add(rh);
        Controls.Add(right); Controls.Add(left);

        if (edit != null) LoadExisting(edit);
        else { _proto.SelectedIndex = 0; PickTemplate(DeviceTemplate.All[1], true); }
    }

    static Control Field(string label, Control c, int width)
    {
        var p = new Panel { Width = width, Height = 58, Margin = new Padding(0, 0, 10, 0), BackColor = Theme.Bg };
        var l = Skin.Lbl(label); l.AutoSize = false; l.Dock = DockStyle.Top; l.Height = 22; l.Font = Theme.Small;
        c.Dock = DockStyle.Top; Skin.Input(c);
        p.Controls.Add(c); p.Controls.Add(l);
        return p;
    }

    PlcSource CurSource => ProtocolSpec.Streamable[Math.Max(0, _proto.SelectedIndex)];

    /// <summary>Dựng ô kết nối (địa chỉ, cổng, tuỳ chọn) và ô thông số riêng theo giao thức đang chọn. Giá trị lấy từ cấu hình đã lưu, thiếu thì hiện gợi ý.</summary>
    void RebuildBind(PlcConnection? conn, Dictionary<string, string>? prm)
    {
        var src = CurSource;
        conn ??= _app.Config.ConnectionFor(src);
        _rowConn.SuspendLayout(); _rowParam.SuspendLayout();
        _rowConn.Controls.Clear(); _rowParam.Controls.Clear(); _connInputs.Clear(); _paramInputs.Clear();
        var rtu = src == PlcSource.ModbusRtu;
        if (ProtocolSpec.UsesHostPort(src))
        {
            var host = new TextBox { Text = conn?.Host ?? "" }; _connInputs["host"] = host;
            var port = new TextBox { Text = (conn?.Port > 0 ? conn.Port : ProtocolSpec.SuggestPort(src)).ToString() }; _connInputs["port"] = port;
            _rowConn.Controls.Add(Field(rtu ? "Cổng COM" : "Địa chỉ PLC (IP/tên máy)", host, 250));
            _rowConn.Controls.Add(Field(rtu ? "Baud" : "Cổng", port, 110));
        }
        else _rowConn.Controls.Add(Skin.Lbl("Beckhoff ADS đi qua router ADS (AmsNetId bên dưới); không có địa chỉ/cổng IP riêng."));
        foreach (var d in ProtocolSpec.ConnOptions(src)) AddInput(_rowConn, _connInputs, "Kết nối: " + d.Label, d, conn?.Opt(d.Key));
        foreach (var d in ProtocolSpec.Params(src)) AddInput(_rowParam, _paramInputs, d.Label, d, prm != null && prm.TryGetValue(d.Key, out var pv) ? pv : null);
        _rowConn.ResumeLayout(); _rowParam.ResumeLayout();
        _addrHint.Text = DeviceTemplate.AddressHint(src);
    }

    void AddInput(FlowLayoutPanel row, Dictionary<string, Control> map, string label, ParamDef d, string? value)
    {
        Control c;
        if (d.Choices != null) { var cb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList }; cb.Items.AddRange(d.Choices); cb.SelectedItem = value ?? d.Default; if (cb.SelectedIndex < 0) cb.SelectedIndex = 0; c = cb; }
        else c = new TextBox { Text = value ?? d.Default };
        map[d.Key] = c;
        row.Controls.Add(Field(label, c, d.Choices != null ? 140 : 170));
    }

    static string Read(Control c) => c is ComboBox cb ? Convert.ToString(cb.SelectedItem) ?? "" : c.Text.Trim();
    Dictionary<string, string> ReadParams() => _paramInputs.ToDictionary(kv => kv.Key, kv => Read(kv.Value));

    void BuildGrid()
    {
        Skin.Grid(_g);
        _g.ReadOnly = false; _g.AllowUserToAddRows = true; _g.AllowUserToDeleteRows = true; _g.EditMode = DataGridViewEditMode.EditOnEnter;
        _g.SelectionMode = DataGridViewSelectionMode.CellSelect; _g.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
        void T(string h, int w) => _g.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = h, Width = w, SortMode = DataGridViewColumnSortMode.NotSortable });
        T("Field", 80); T("Nhãn hiển thị", 120);
        var acc = new DataGridViewComboBoxColumn { HeaderText = "Quyền", Width = 84, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable }; acc.Items.AddRange(AccessNames); _g.Columns.Add(acc);
        var ty = new DataGridViewComboBoxColumn { HeaderText = "Kiểu", Width = 80, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable }; ty.Items.AddRange(TypeNames); _g.Columns.Add(ty);
        T("D", 50); T("Hệ số", 60); T("Đơn vị", 64); T("Min ghi", 60); T("Max ghi", 60);
        var kind = new DataGridViewComboBoxColumn { HeaderText = "Hiển thị", Width = 108, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable };
        kind.Items.AddRange(FieldMeta.KindNames); _g.Columns.Add(kind);
        T("Chữ khi Bật", 100); T("Chữ khi Tắt", 90); T("Ngưỡng thấp", 96); T("Ngưỡng cao", 92);
        _g.DataError += (_, e) => e.ThrowException = false;
        _g.CurrentCellDirtyStateChanged += (_, _) => { if (_g.IsCurrentCellDirty && _g.CurrentCell is DataGridViewComboBoxCell) _g.CommitEdit(DataGridViewDataErrorContexts.Commit); };
    }

    /// <summary>Các word D đã bị thiết bị khác chiếm trên CÙNG PLC (cùng giao thức + thông số) với lựa chọn hiện tại.</summary>
    HashSet<int> UsedElsewhere()
    {
        var key = PackDriverPool.Key(new PackMap { Protocol = CurSource.ToString(), Params = ReadParams() });
        var used = new HashSet<int>();
        foreach (var p in _app.Config.Pack.Where(p => (_edit == null || p.Child != _edit) && p.IsBound && p.Address >= 0 && PackDriverPool.Key(p) == key))
            for (var i = 0; i < p.Words; i++) used.Add(p.Address + i);
        return used;
    }

    void PickTemplate(DeviceTemplate t, bool fill)
    {
        _tpl = t;
        foreach (var x in _tiles) { x.Selected = x.Tpl == t; x.Invalidate(); }
        if (!fill) return;
        if (!_childTouched || string.IsNullOrWhiteSpace(_child.Text)) { _child.Text = UniqueChild(t.IdPrefix); _childTouched = false; }
        _title.Text = t.DefaultTitle;
        _g.Rows.Clear();
        var used = UsedElsewhere(); var next = 50;
        foreach (var f in t.Fields)
        {
            while (used.Contains(next) && next < Contract.MaxRegister - 1) next++;
            used.Add(next);
            var ki = Math.Max(0, Array.IndexOf(FieldMeta.Kinds, f.Kind));
            _g.Rows.Add(f.Field, f.Label, f.Writable ? "Đọc/ghi" : "Chỉ đọc", "UINT", next.ToString(), Num(f.Scale), f.Unit, f.Writable ? Num(f.Min) : "", f.Writable ? Num(f.Max) : "",
                FieldMeta.KindNames[ki], f.On, f.Off, f.Low is { } lo ? Num(lo) : "", f.High is { } hi ? Num(hi) : "");
        }
    }

    string UniqueChild(string prefix)
    {
        var used = _app.Config.Pack.Select(p => p.Child).ToHashSet();
        for (var i = 1; ; i++) if (!used.Contains(prefix + i)) return prefix + i;
    }

    static string Num(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);

    void LoadExisting(string child)
    {
        _child.Text = child;
        var dm = _app.Meta.Device(child);
        _title.Text = string.IsNullOrWhiteSpace(dm?.Title) ? child : dm!.Title;
        var tpl = DeviceTemplate.Find(dm?.Template ?? "") ?? DeviceTemplate.All[^1];
        PickTemplate(tpl, false);
        var first = _app.Config.Pack.First(x => x.Child == child);
        if (first.Source is { } fs) _proto.SelectedIndex = Math.Max(0, Array.IndexOf(ProtocolSpec.Streamable, fs));
        else _proto.SelectedIndex = Math.Max(0, Array.IndexOf(ProtocolSpec.Streamable, _app.Config.Source));
        RebuildBind(null, first.IsBound ? first.Params : null);
        _swap.SelectedIndex = first.WordSwap ? 1 : 0;
        foreach (var p in _app.Config.Pack.Where(x => x.Child == child))
        {
            var m = _app.Meta.Get(child, p.Field);
            var r = FieldMeta.ResolveFull(p, m);
            var ki = Math.Max(0, Array.IndexOf(FieldMeta.Kinds, r.Kind));
            _g.Rows.Add(p.Field, m?.Title ?? "", AccessNames[(int)p.Access], TypeNames[(int)p.DataType], p.Address >= 0 ? p.Address.ToString() : "", p.Scale > 0 ? Num(p.Scale) : "", r.Unit,
                p.Min is { } a ? Num(a) : "", p.Max is { } b ? Num(b) : "",
                FieldMeta.KindNames[ki], m?.OnText ?? "", m?.OffText ?? "", m?.Low is { } lo ? Num(lo) : "", m?.High is { } hi ? Num(hi) : "");
        }
    }

    static string Cell(DataGridViewRow r, int c) => (Convert.ToString(r.Cells[c].Value) ?? "").Trim();

    static bool TryNum(string s, out double? v)
    {
        v = null; if (s.Length == 0) return true;
        if (!double.TryParse(s.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return false;
        v = d; return true;
    }

    void Commit()
    {
        var rx = new Regex("^[A-Za-z0-9_-]{1,48}$");
        var child = _child.Text.Trim();
        if (!rx.IsMatch(child)) { _err.Text = "Mã thiết bị chỉ gồm chữ, số, _ và -, tối đa 48 ký tự."; return; }
        if (_edit == null && _app.Config.Pack.Any(p => p.Child == child)) { _err.Text = $"Mã \"{child}\" đã có thiết bị khác."; return; }
        var rows = _g.Rows.Cast<DataGridViewRow>().Where(r => !r.IsNewRow && Cell(r, ColField).Length > 0).ToList();
        if (rows.Count == 0) { _err.Text = "Cần ít nhất một field."; return; }
        // kết nối + thông số giao thức: đủ và hợp lệ (không ngầm định)
        var src = CurSource;
        var prm = ReadParams();
        var pe = ProtocolSpec.ValidateParams(src, prm, "Thông số");
        if (pe != null) { _err.Text = pe; return; }
        var conn = new PlcConnection { Protocol = src };
        if (ProtocolSpec.UsesHostPort(src))
        {
            conn.Host = Read(_connInputs["host"]);
            if (conn.Host.Length == 0) { _err.Text = "Nhập địa chỉ PLC (hoặc cổng COM)."; return; }
            if (!int.TryParse(Read(_connInputs["port"]), out var port) || port is < 1 or > 65535) { _err.Text = "Cổng không hợp lệ (1–65535)."; return; }
            conn.Port = port;
        }
        foreach (var (k, c) in _connInputs.Where(x => x.Key is not ("host" or "port"))) conn.Options[k] = Read(c);
        var oe = ProtocolSpec.ValidateParams(src, conn.Options, "Kết nối", ProtocolSpec.ConnOptions(src));
        if (oe != null) { _err.Text = oe; return; }

        var used = UsedElsewhere(); var names = new HashSet<string>();
        var swap = _swap.SelectedIndex == 1;
        var packs = new List<(PackMap P, FieldMeta M)>();
        foreach (var r in rows)
        {
            var f = Cell(r, ColField); var line = r.Index + 1;
            if (!rx.IsMatch(f)) { _err.Text = $"Dòng {line}: field chỉ gồm chữ, số, _ và -."; return; }
            if (!names.Add(f)) { _err.Text = $"Dòng {line}: field \"{f}\" bị trùng."; return; }
            var ai = Array.IndexOf(AccessNames, Convert.ToString(r.Cells[ColAccess].Value));
            var ti = Array.IndexOf(TypeNames, Convert.ToString(r.Cells[ColType].Value));
            if (ai < 0 || ti < 0) { _err.Text = $"Dòng {line}: chọn quyền và kiểu dữ liệu."; return; }
            var type = (PlcDataType)ti; var words = PackCodec.Words(type);
            if (!int.TryParse(Cell(r, ColD), out var addr) || addr < 0 || addr + words > Contract.MaxRegister) { _err.Text = $"Dòng {line}: thanh ghi D từ 0, kiểu {TypeNames[ti]} chiếm {words} word và phải nằm trong D0–D{Contract.MaxRegister - 1}."; return; }
            for (var w = 0; w < words; w++) if (!used.Add(addr + w)) { _err.Text = $"Dòng {line}: D{addr + w} đã được dùng (cùng PLC)."; return; }
            if (!TryNum(Cell(r, ColScale), out var sc) || sc is null or <= 0) { _err.Text = $"Dòng {line}: hệ số phải là số dương."; return; }
            if (!TryNum(Cell(r, ColMin), out var mn) || !TryNum(Cell(r, ColMax), out var mx)) { _err.Text = $"Dòng {line}: Min/Max phải là số."; return; }
            if (mn.HasValue && mx.HasValue && mn > mx) { _err.Text = $"Dòng {line}: Min lớn hơn Max."; return; }
            if (!TryNum(Cell(r, ColLow), out var lo) || !TryNum(Cell(r, ColHigh), out var hi)) { _err.Text = $"Dòng {line}: ngưỡng phải là số."; return; }
            var kn = Convert.ToString(r.Cells[ColKind].Value); var ki = Array.IndexOf(FieldMeta.KindNames, kn);
            packs.Add((new PackMap
                {
                    Child = child, Field = f, Address = addr, Scale = sc!.Value, Min = mn, Max = mx,
                    Protocol = src.ToString(), Access = (PackAccess)ai, DataType = type, WordSwap = swap, Params = new Dictionary<string, string>(prm),
                },
                new FieldMeta { Kind = FieldMeta.Kinds[Math.Max(0, ki)], Unit = Cell(r, ColUnit), Title = Cell(r, ColTitle), OnText = Cell(r, ColOn), OffText = Cell(r, ColOff), Low = lo, High = hi }));
        }

        // áp vào cấu hình
        foreach (var old in _app.Config.Pack.Where(p => p.Child == child).ToList()) { _app.Config.Pack.Remove(old); _app.Meta.Remove(child, old.Field); }
        foreach (var (p, m) in packs) { _app.Config.Pack.Add(p); _app.Meta.Set(child, p.Field, m); }
        _app.Config.Connections.RemoveAll(c => c.Protocol == src);
        _app.Config.Connections.Add(conn);
        _app.Meta.SetDevice(child, new DeviceMeta { Title = _title.Text.Trim(), Template = _tpl.Id });
        DialogResult = DialogResult.OK; Close();
    }

    /// <summary>Tạo hộp thoại không hiện modal (để chụp ảnh kiểm tra giao diện).</summary>
    public static Form Preview(IGatewayApp app, string? editChild) => new DeviceDialog(app, editChild);

    /// <summary>Mở hộp thoại thêm (editChild = null) hoặc sửa. Đúng = đã áp vào cấu hình, người gọi nên gọi ApplyAsync.</summary>
    public static bool Run(IGatewayApp app, IWin32Window owner, string? editChild, out string child) => Run(app, owner, editChild, out child, out _);

    public static bool Run(IGatewayApp app, IWin32Window owner, string? editChild, out string child, out bool deleted)
    {
        using var d = new DeviceDialog(app, editChild);
        if (Hook != null) { var hook = Hook; d.Shown += (_, _) => hook(d); }
        var ok = d.ShowDialog(owner) == DialogResult.OK;
        child = d._child.Text.Trim(); deleted = d.Deleted;
        return ok;
    }
}

/// <summary>Trang Thiết bị: bảng các field của mọi thiết bị + nút thêm thiết bị ngoại vi.</summary>
sealed class DevicesPage : UserControl
{
    readonly IGatewayApp _app;
    readonly DataGridView _g = new() { Dock = DockStyle.Fill };
    FlatButton? _addBtn;
    string _sig = "";

    public DevicesPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_g);
        foreach (var (n, h, w) in new[] { ("c", "Thiết bị", 160), ("f", "Field", 90), ("l", "Nhãn", 110), ("p", "Giao thức", 120), ("a", "Quyền", 70), ("t", "Kiểu", 60), ("d", "Thanh ghi", 90), ("s", "Hệ số", 50), ("lim", "Giới hạn ghi", 90), ("k", "Hiển thị", 90), ("u", "Đơn vị", 56), ("v", "Giá trị hiện tại", 110) })
            _g.Columns.Add(new DataGridViewTextBoxColumn { Name = n, HeaderText = h, Width = w });
        _g.Columns[^1].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6) };
        var add = _addBtn = new FlatButton { Caption = "＋  Thêm thiết bị ngoại vi", Primary = true, Width = 210 };
        var edit = new FlatButton { Caption = "Sửa thiết bị", Width = 120 };
        var del = new FlatButton { Caption = "Xoá thiết bị", Width = 120, Danger = true };
        add.Click += (_, _) => AddOrEdit(null);
        edit.Click += (_, _) => AddOrEdit(SelectedChild());
        del.Click += async (_, _) => await Delete();
        _g.CellDoubleClick += (_, e) => { if (e.RowIndex >= 0) AddOrEdit(SelectedChild()); };
        _g.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Delete) { e.Handled = true; await Delete(); } };
        bar.Controls.AddRange(new Control[] { add, edit, del });

        var card = new Card { Title = "Thiết bị ngoại vi", Sub = "mỗi dòng: giao thức + quyền + kiểu + ô nhớ D của PLC → d.<thiết bị>.<field>", Dock = DockStyle.Fill, Padding = new Padding(2, 40, 2, 2) };
        card.Controls.Add(_g);
        Controls.Add(card); Controls.Add(bar);
        Refill();
    }

    string? SelectedChild() => _g.CurrentRow == null ? null : Convert.ToString(_g.CurrentRow.Cells[0].Tag);

    void AddOrEdit(string? child)
    {
        if (!DeviceDialog.Run(_app, FindForm()!, child, out var c, out var deleted)) return;
        Refill(); _ = _app.ApplyAsync(deleted ? $"Đã xoá thiết bị {c}" : child == null ? $"Đã thêm thiết bị {c}" : $"Đã lưu thiết bị {c}");
    }

    async Task Delete()
    {
        var c = SelectedChild(); if (c == null) { _app.Toast("Chọn một dòng của thiết bị cần xoá.", true); return; }
        if (!DeviceDialog.ConfirmDelete(_app, FindForm(), c)) return;
        DeviceDialog.Remove(_app, c);
        Refill(); await _app.ApplyAsync($"Đã xoá thiết bị {c}");
    }

    string Sig() => string.Join("|", _app.Config.Pack.Select(p => $"{p.Child}.{p.Field}@{p.Address}x{p.Scale}[{p.Min}-{p.Max}]{p.Protocol}/{p.Access}/{p.DataType}"))
        + string.Join("|", _app.Meta.Map.Select(kv => kv.Key + kv.Value.Kind + kv.Value.Unit + kv.Value.Title)) + string.Join("|", _app.Meta.Devices.Select(kv => kv.Key + kv.Value.Title));

    void Refill()
    {
        _sig = Sig();
        var keep = _g.CurrentRow?.Index ?? -1;
        _g.Rows.Clear();
        foreach (var p in _app.Config.Pack)
        {
            var m = _app.Meta.Get(p.Child, p.Field);
            var r = FieldMeta.ResolveFull(p, m);
            var lim = p.Min.HasValue || p.Max.HasValue ? $"{(p.Min?.ToString(CultureInfo.InvariantCulture) ?? "…")} – {(p.Max?.ToString(CultureInfo.InvariantCulture) ?? "…")}" : "không";
            var dev = _app.Meta.Device(p.Child);
            var dtxt = p.Address < 0 ? "chưa khai báo" : p.Words == 1 ? "D" + p.Address : $"D{p.Address}–{p.Address + p.Words - 1}";
            var i = _g.Rows.Add(string.IsNullOrWhiteSpace(dev?.Title) ? p.Child : $"{dev!.Title} ({p.Child})", p.Field, m?.Title ?? "",
                p.Source is { } ps ? ProtocolSpec.Name(ps) : "chưa gán", p.Source is null ? "—" : new[] { "Chỉ đọc", "Chỉ ghi", "Đọc/ghi" }[(int)p.Access], p.Source is null ? "—" : new[] { "UINT", "INT", "BOOL", "UDINT", "DINT", "REAL", "LREAL" }[(int)p.DataType],
                dtxt, p.Scale > 0 ? p.Scale.ToString(CultureInfo.InvariantCulture) : "—", lim,
                FieldMeta.KindNames[Math.Max(0, Array.IndexOf(FieldMeta.Kinds, r.Kind))], r.Unit, "—");
            _g.Rows[i].Cells[0].Tag = p.Child;
        }
        if (keep >= 0 && keep < _g.Rows.Count) _g.CurrentCell = _g.Rows[keep].Cells[0];
    }

    public void Tick()
    {
        if (Sig() != _sig) Refill();
        foreach (DataGridViewRow r in _g.Rows)
        {
            var key = UiMetaStore.Key(Convert.ToString(r.Cells[0].Tag) ?? "", Convert.ToString(r.Cells[1].Value) ?? "");
            r.Cells[11].Value = _app.TryValue(key, out var v) ? Theme.Num(v) : "—";
        }
    }
}
