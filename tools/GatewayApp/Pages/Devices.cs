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
        Icons.Badge(g, Icons.ForDevice(Tpl.Id, Tpl.Id), new RectangleF(10, 9, 40, 40), Selected ? Theme.Accent : Theme.Teal, 9, 50, device: true);   // icon vector giống webapp
        TextRenderer.DrawText(g, Tpl.Name, Theme.Semi, new Rectangle(64, 8, Width - 70, 22), Theme.Text, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        TextRenderer.DrawText(g, Tpl.Desc, Theme.Small, new Rectangle(64, 31, Width - 70, 20), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>Cửa sổ ứng dụng giả cho khung xem trước: thẻ vẽ bằng metadata đang nhập, giá trị mẫu, không gửi lệnh nào.</summary>
sealed class PreviewApp : IGatewayApp
{
    readonly IGatewayApp _real;
    public PreviewApp(IGatewayApp real)
    {
        _real = real;
        Meta = new UiMetaStore(Path.Combine(Path.GetTempPath(), "gw-preview.json")) { Persist = false };
    }
    public string GatewayKind { get; init; } = "";
    public ScadaConfig Config { get; } = new();
    public UiMetaStore Meta { get; }
    public HistoryStore History => _real.History;
    public bool Running => false;
    public Dictionary<string, double> Sample { get; } = new();
    public bool TryValue(string key, out double v) => Sample.TryGetValue(key, out v);
    public Task<string?> WriteAsync(string child, string field, double value) => Task.FromResult<string?>(null);
    public Task ApplyAsync(string why) => Task.CompletedTask;
    public Task<string?> SetDeviceEnabledAsync(string child, bool enabled) => Task.FromResult<string?>(null);
    public string FingerprintText => "";
    public string HwText => "";
    public Task<(bool Ok, string Msg)> CloudAsync(string action, string api, string value) => Task.FromResult((false, "xem trước"));
    public void Toast(string text, bool error = false) { }
    public void SaveConfig() { }
    public (long Total, long Unsent, long Oldest) HistoryStats() => (0, 0, 0);
    public Task<long> ExportHistoryAsync(string path, string format, long fromMs, long toMs) => Task.FromResult(0L);
    public bool RequireEdit() => true;   // chỉ để xem trước hộp thoại: không có gì để bảo vệ
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
    readonly ComboBox _icon = new() { DropDownStyle = ComboBoxStyle.DropDownList }, _color = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    static readonly DeviceTemplate[] IconChoices = DeviceTemplate.All.GroupBy(t => t.Icon).Select(g => g.First()).ToArray();
    readonly Panel _prevHost = new() { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Theme.Bg };
    readonly System.Windows.Forms.Timer _prevTimer = new() { Interval = 200 };
    readonly PreviewApp _pa;

    const int ColField = 0, ColMqtt = 1, ColTitle = 2, ColAccess = 3, ColType = 4, ColD = 5, ColScale = 6, ColUnit = 7, ColMin = 8, ColMax = 9, ColKind = 10, ColOn = 11, ColOff = 12, ColLow = 13, ColHigh = 14, ColFb = 15, ColSlot = 16;
    const string NoSlot = "— Widget riêng —";

    // Kết nối + thông số giao thức + thứ tự word: khai báo rõ cho thiết bị, không có giá trị ngầm định (ô gợi ý có thể sửa)
    static readonly string[] AccessNames = { "Chỉ đọc", "Chỉ ghi", "Đọc/ghi" };
    static readonly string[] TypeNames = { "UINT", "INT", "BOOL", "UDINT", "DINT", "REAL", "LREAL" };    // theo thứ tự PlcDataType
    static readonly string[] SwapNames = { "Word cao trước (AB CD)", "Word thấp trước (CD AB)" };
    readonly bool _board;
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly ComboBox _swap = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly FlowLayoutPanel _rowConn = new() { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
    readonly FlowLayoutPanel _rowParam = new() { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
    readonly Dictionary<string, Control> _connInputs = new(), _paramInputs = new();
    readonly Label _addrHint = new() { ForeColor = Theme.Accent, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 22 };

    // ----- Nối chân board: 3 kiểu — cảm biến (DI), điều khiển (DO), phản hồi (DI) của chính thiết bị điều khiển đó
    const string NoPin = "— Không dùng —";
    readonly ComboBox _wDi = new() { DropDownStyle = ComboBoxStyle.DropDownList }, _wDo = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly FlowLayoutPanel _wire = new() { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0), Visible = false };
    Control _wDiBox = null!, _wDoBox = null!;
    /// <summary>Danh sách giao thức PHỤ THUỘC loại thiết bị đích. Waveshare: Digital I/O (nối bơm/van/đèn… với chân DO/DI) + RS485 (Modbus RTU; I2C, CAN thêm sau khi firmware hỗ trợ). Thiết bị khác: Modbus TCP / RTU.
    /// Src = giao thức Modbus thật dùng để nói chuyện (từ PC: Modbus TCP tới IP board, board là slave và là cầu RS485).</summary>
    sealed record ProtoOpt(string Name, PlcSource Src, bool Dio, bool Usable = true);
    readonly List<ProtoOpt> _opts = new();
    readonly ComboBox _target = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly List<(string Hw, string Ip)> _boards = new();
    bool _protoBusy;
    Label _hintLbl = null!;
    bool WaveshareTarget => _board || _target.SelectedIndex > 0;
    bool DioSel => _proto.SelectedIndex >= 0 && _proto.SelectedIndex < _opts.Count && _opts[_proto.SelectedIndex].Dio;

    /// <summary>Dựng lại danh sách giao thức theo thiết bị đích (Waveshare hay thiết bị Modbus khác).</summary>
    void RebuildProtos(int select = 0)
    {
        _protoBusy = true;
        _opts.Clear(); _proto.Items.Clear();
        if (WaveshareTarget)
        {
            // danh sách theo firmware báo (ApiHello.Protocols): thêm giao tiếp mới ở firmware là hộp thoại tự hiện thêm
            var src = _board ? PlcSource.ModbusRtu : PlcSource.ModbusTcp;
            foreach (var id in BoardProtocols())
                _opts.Add(id switch
                {
                    "dio" => new("Digital I/O — đầu vào / đầu ra số (DI/DO)", src, true),
                    "rs485" => new(_board ? "RS485 — Modbus RTU (cổng RS485 của board)" : "RS485 — Modbus RTU qua board (Unit = địa chỉ slave)", src, false),
                    _ => new($"{id.ToUpperInvariant()} — board hỗ trợ, GatewayApp chưa dùng được", src, false, Usable: false),
                });
        }
        else foreach (var s in ProtocolSpec.Streamable) _opts.Add(new(ProtocolSpec.Name(s), s, false));
        foreach (var o in _opts) _proto.Items.Add(o.Name);
        _proto.SelectedIndex = Math.Clamp(select, 0, _opts.Count - 1);
        _protoBusy = false;
    }

    /// <summary>Giao thức board hỗ trợ: trên board = chính firmware (app.Protocols); từ gateway PC = board đích đã nhớ từ gói tìm thiết bị.</summary>
    string[] BoardProtocols() => _board ? (_app.Protocols.Length > 0 ? _app.Protocols : new[] { "dio", "rs485" }) : TrustedBoards.ProtocolsOf(_target.SelectedIndex > 0 ? _boards[_target.SelectedIndex - 1].Hw : "");

    void SelectSource(PlcSource s) { var i = _opts.FindIndex(o => o.Src == s && !o.Dio); _protoBusy = true; _proto.SelectedIndex = i >= 0 ? i : 0; _protoBusy = false; }

    /// <summary>Đổi giao thức / thiết bị đích: dựng lại ô kết nối, và các dòng field nếu vào / ra chế độ Digital I/O.</summary>
    void OnProtoChanged()
    {
        if (_protoBusy) return;
        if (_proto.SelectedIndex >= 0 && _proto.SelectedIndex < _opts.Count && !_opts[_proto.SelectedIndex].Usable)
        {
            _err.Text = "Board có giao tiếp này nhưng GatewayApp chưa hỗ trợ — sẽ mở rộng sau.";
            _protoBusy = true; _proto.SelectedIndex = 0; _protoBusy = false;
        }
        if (DioSel && !_tpl.Wire) { _err.Text = "Loại thiết bị này không có công tắc bật/tắt để nối DI/DO — chọn bơm, van, đèn, quạt… hoặc \"Đầu vào số\"."; _protoBusy = true; _proto.SelectedIndex = Math.Min(1, _opts.Count - 1); _protoBusy = false; }
        else _err.Text = "";
        RebuildBind(null, null);
        if (!_board && _target.SelectedIndex > 0 && _connInputs.TryGetValue("host", out var h)) { h.Text = _boards[_target.SelectedIndex - 1].Ip; if (_connInputs.TryGetValue("port", out var p)) p.Text = "502"; }
        if (_edit == null) PickTemplate(_tpl, true);   // vào / ra chế độ Digital I/O: dựng lại các dòng field theo chân hoặc thanh ghi
    }
    bool HwOn => _tpl.Wire && _edit == null && DioSel;
    readonly Label _wNote = new() { ForeColor = Theme.Accent, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 38, Visible = false };
    FlowLayoutPanel _rowProto = null!;
    bool _wBusy; string _autoTitle = "";

    /// <summary>Kiểm thử tự động (--edittest, --slottest): kịch bản chạy khi hộp thoại hiện.</summary>
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
        _app = app; _edit = edit; _board = app.GatewayKind == "mcu";
        Text = edit == null ? "Thêm thiết bị ngoại vi" : $"Sửa thiết bị {edit}";
        FormBorderStyle = FormBorderStyle.Sizable; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(1500, 820); MinimumSize = new Size(1250, 700);
        _pa = new PreviewApp(app);

        // ----- trái: loại thiết bị
        var left = new Panel { Dock = DockStyle.Left, Width = 292, Padding = new Padding(14, 12, 6, 8), BackColor = Theme.Bg };
        var lh = new Label { Text = "1. Loại thiết bị vật lý", ForeColor = Theme.Text, Font = Theme.Title, AutoSize = false, Dock = DockStyle.Top, Height = 30 };
        var list = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Theme.Bg };
        foreach (var t in DeviceTemplate.All.OrderBy(x => _board && x.BoardIo ? 0 : 1))   // board Waveshare: mẫu DI/DO của board lên đầu
        {
            var tile = new TemplateTile(t);
            tile.Click += (_, _) => { if (_edit == null) PickTemplate(t, true); };
            _tiles.Add(tile); list.Controls.Add(tile);
        }
        // Loại gateway tự nhận diện (app.GatewayKind): board Waveshare ESP32 → thêm mẫu nối chân DI/DO + bộ đếm lên đầu danh sách
        // mẫu DI/DO của board hiện ở cả hai nơi: cấu hình trên board (Modbus RTU Unit 0) hoặc từ gateway PC (Modbus TCP tới board, board là slave)
        left.Controls.Add(list); left.Controls.Add(lh);
        if (edit != null) left.Visible = false;

        // ----- phải: thông số
        var right = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 12, 16, 8), BackColor = Theme.Bg };
        var rh = new Label { Text = edit == null ? "2. Thông số thiết bị" : "Thông số thiết bị", ForeColor = Theme.Text, Font = Theme.Title, AutoSize = false, Dock = DockStyle.Top, Height = 30 };
        Skin.Input(_child); Skin.Input(_title);
        var top = new TableLayoutPanel { Dock = DockStyle.Top, Height = 88, ColumnCount = 4, RowCount = 2, BackColor = Theme.Bg };
        top.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); top.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
        top.Controls.Add(Skin.Lbl("Mã thiết bị (child)")); _child.Dock = DockStyle.Fill; _child.Margin = new Padding(0, 6, 12, 6); top.Controls.Add(_child);
        top.Controls.Add(Skin.Lbl("Tên hiển thị")); _title.Dock = DockStyle.Fill; _title.Margin = new Padding(0, 6, 0, 6); top.Controls.Add(_title);
        Skin.Input(_icon); Skin.Input(_color);
        _icon.Items.Add("Theo loại thiết bị"); foreach (var t in IconChoices) _icon.Items.Add(t.Name);
        // mỗi mục vẽ icon vector thật (giống thẻ thiết bị và webapp) thay cho ký tự Unicode
        _icon.DrawMode = DrawMode.OwnerDrawFixed; _icon.ItemHeight = 24;
        _icon.DrawItem += (_, e) =>
        {
            if (e.Index < 0) return;
            var sel = (e.State & DrawItemState.Selected) != 0 && (e.State & DrawItemState.ComboBoxEdit) == 0;
            using (var bg = new SolidBrush(sel ? Theme.Mix(Theme.Panel2, Theme.Accent, 0.35) : Theme.Panel2)) e.Graphics.FillRectangle(bg, e.Bounds);
            Theme.Quality(e.Graphics);
            var id = e.Index == 0 ? "gear" : IconChoices[e.Index - 1].Id;
            Icons.Draw(e.Graphics, Icons.ForDevice(id, id), new RectangleF(e.Bounds.X + 6, e.Bounds.Y + 3, e.Bounds.Height - 6, e.Bounds.Height - 6), e.Index == 0 ? Theme.Muted : Theme.Teal, null, true);
            TextRenderer.DrawText(e.Graphics, _icon.Items[e.Index]?.ToString() ?? "", Theme.Normal, new Rectangle(e.Bounds.X + e.Bounds.Height + 8, e.Bounds.Y, e.Bounds.Width - e.Bounds.Height - 10, e.Bounds.Height), Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        };
        _color.Items.AddRange(DeviceStyle.ColorNames); _icon.SelectedIndex = 0; _color.SelectedIndex = 0;
        top.Controls.Add(Skin.Lbl("Biểu tượng thẻ")); _icon.Dock = DockStyle.Fill; _icon.Margin = new Padding(0, 6, 12, 6); top.Controls.Add(_icon);
        top.Controls.Add(Skin.Lbl("Màu nhấn")); _color.Dock = DockStyle.Fill; _color.Margin = new Padding(0, 6, 0, 6); top.Controls.Add(_color);
        _child.TextChanged += (_, _) => { if (_child.Focused) _childTouched = true; };
        if (edit != null) _child.Enabled = false;

        var hint = _hintLbl = new Label
        {
            Text = "Mọi thông số khai báo rõ ở đây — gateway không tự ngầm định. Quyền: chỉ đọc (PLC → gateway), chỉ ghi, hoặc đọc/ghi. Kiểu: UDINT/DINT/REAL chiếm 2 word, LREAL 4 word (D kế tiếp tự tính). " +
                   "Min/Max = khoảng cho phép GHI (thanh trượt cũng dùng khoảng này). Kết nối dùng chung cho mọi thiết bị cùng giao thức.",
            ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 40,
        };
        var rowProto = _rowProto = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, BackColor = Theme.Bg, WrapContents = true, Margin = new Padding(0) };
        // thiết bị đích: Waveshare đã ghép (tự điền IP) hoặc thiết bị Modbus khác — quyết định danh sách giao thức
        _target.Items.Add("PLC / thiết bị Modbus khác");
        foreach (var kv in TrustedBoards.All()) { _boards.Add((kv.Key, kv.Value)); _target.Items.Add($"Waveshare ESP32-S3 — {kv.Value}"); }
        _target.SelectedIndex = 0;
        _target.SelectedIndexChanged += (_, _) => { RebuildProtos(0); OnProtoChanged(); };
        RebuildProtos(0);
        _swap.Items.AddRange(SwapNames); _swap.SelectedIndex = 0;
        Skin.Input(_proto); Skin.Input(_swap);
        if (edit == null && !_board) rowProto.Controls.Add(Field("Thiết bị đích", _target, 290));
        rowProto.Controls.Add(Field("Giao thức", _proto, 320)); rowProto.Controls.Add(Field("Thứ tự word (kiểu ≥ 32-bit)", _swap, 230));
        _proto.SelectedIndexChanged += (_, _) => OnProtoChanged();
        Skin.Input(_wDi); Skin.Input(_wDo);
        _wDiBox = Field("Chân DI phản hồi / cảm biến (tuỳ chọn)", _wDi, 300); _wDoBox = Field("Chân DO điều khiển (tuỳ chọn)", _wDo, 300);
        _wire.Controls.Add(_wDoBox); _wire.Controls.Add(_wDiBox);
        _wDi.SelectedIndexChanged += (_, _) => { if (!_wBusy) { UpdateWireUi(); ApplyWire(); } };
        _wDo.SelectedIndexChanged += (_, _) => { if (!_wBusy) { UpdateWireUi(); ApplyWire(); } };
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
                if (!_app.RequireEdit()) return;
                Remove(_app, edit); Deleted = true;
                DialogResult = DialogResult.OK; Close();
            };
            buttons.Controls.Add(del);
        }

        right.Controls.Add(_g); right.Controls.Add(_err); right.Controls.Add(buttons); right.Controls.Add(hint); right.Controls.Add(_addrHint);
        right.Controls.Add(_rowParam); right.Controls.Add(_rowConn); right.Controls.Add(rowProto); right.Controls.Add(_wNote); right.Controls.Add(_wire); right.Controls.Add(top); right.Controls.Add(rh);

        // ----- phải: xem trước thẻ đúng như trên Tổng quan, cập nhật khi đổi bất kỳ thông tin hiển thị nào
        var prev = new Panel { Dock = DockStyle.Right, Width = 404, Padding = new Padding(6, 12, 14, 8), BackColor = Theme.Bg };
        var ph = new Label { Text = "Xem trước thẻ trên Tổng quan", ForeColor = Theme.Text, Font = Theme.Title, AutoSize = false, Dock = DockStyle.Top, Height = 30 };
        var pn = new Label { Text = "Vẽ bằng nhãn, đơn vị, kiểu hiển thị, chữ Bật/Tắt, ngưỡng, biểu tượng và màu đang nhập. Giá trị mẫu ở giữa khoảng Min–Max; chỉ xem, không gửi lệnh.", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Dock = DockStyle.Top, Height = 52 };
        prev.Controls.Add(_prevHost); prev.Controls.Add(pn); prev.Controls.Add(ph);
        _prevTimer.Tick += (_, _) => { _prevTimer.Stop(); RebuildPreview(); };
        FormClosed += (_, _) => _prevTimer.Dispose();
        void Queue(object? a, EventArgs b) { _prevTimer.Stop(); _prevTimer.Start(); }
        _g.CellValueChanged += (_, _) => Queue(null, EventArgs.Empty);
        _g.RowsAdded += (_, _) => Queue(null, EventArgs.Empty);
        _g.RowsRemoved += (_, _) => Queue(null, EventArgs.Empty);
        // gõ TÊN tiếng Việt → mã thiết bị (ASCII) tự sinh theo tên, bỏ dấu ("Bồn nước 1" → bon_nuoc_1); sửa mã tay thì thôi tự sinh
        _title.TextChanged += (_, _) =>
        {
            if (_edit != null || _childTouched || !_title.Focused) return;
            var slug = Vn.Slug(_title.Text);
            if (slug.Length > 0) _child.Text = UniqueChildName(slug);
        };
        _title.TextChanged += Queue; _child.TextChanged += Queue; _icon.SelectedIndexChanged += Queue; _color.SelectedIndexChanged += Queue;
        Controls.Add(right); Controls.Add(prev); Controls.Add(left);

        if (edit != null) LoadExisting(edit);
        else { _protoBusy = true; _proto.SelectedIndex = 0; _protoBusy = false; RebuildBind(null, null); PickTemplate(DeviceTemplate.All[1], true); if (_board) OnProtoChanged(); }
    }

    string IconValue() => _icon.SelectedIndex <= 0 ? "" : IconChoices[_icon.SelectedIndex - 1].Icon;

    void RebuildPreview()
    {
        var child = _child.Text.Trim(); if (child.Length == 0) child = "device";
        _pa.Meta.Map.Clear(); _pa.Meta.Devices.Clear(); _pa.Sample.Clear();
        var fields = new List<PackMap>();
        foreach (DataGridViewRow r in _g.Rows)
        {
            if (r.IsNewRow) continue;
            var f = Cell(r, ColField); if (f.Length == 0 || fields.Any(x => x.Field == f)) continue;
            TryNum(Cell(r, ColMin), out var mn); TryNum(Cell(r, ColMax), out var mx);
            TryNum(Cell(r, ColLow), out var lo); TryNum(Cell(r, ColHigh), out var hi);
            var ai = Array.IndexOf(AccessNames, Convert.ToString(r.Cells[ColAccess].Value));
            var p = new PackMap { Child = child, Field = f, Min = mn, Max = mx, Access = ai >= 0 ? (PackAccess)ai : PackAccess.ReadWrite };
            var ki = Array.IndexOf(FieldMeta.KindNames, Convert.ToString(r.Cells[ColKind].Value));
            var m = new FieldMeta { Kind = FieldMeta.Kinds[Math.Max(0, ki)], Unit = Cell(r, ColUnit), Title = Cell(r, ColTitle), OnText = Cell(r, ColOn), OffText = Cell(r, ColOff), Low = lo, High = hi };
            _pa.Meta.Set(child, f, m); fields.Add(p);
            var rs = FieldMeta.ResolveFull(p, m);
            _pa.Sample[UiMetaStore.Key(child, f)] = rs.Kind == "toggle" ? 1 : (rs.Min + rs.Max) / 2;
        }
        _pa.Meta.SetDevice(child, new DeviceMeta { Title = _title.Text.Trim(), Template = _tpl.Id, Icon = IconValue(), Color = DeviceStyle.ColorKeys[Math.Max(0, _color.SelectedIndex)] });
        foreach (var old in _prevHost.Controls.OfType<DeviceCard>().ToList()) { _prevHost.Controls.Remove(old); old.Dispose(); }
        if (fields.Count == 0) return;
        var card = new DeviceCard(child, fields, _pa, _ => { }, null) { Location = new Point(0, 4) };
        card.Tick(_pa);
        _prevHost.Controls.Add(card);
    }

    static Control Field(string label, Control c, int width)
    {
        var p = new Panel { Width = width, Height = 58, Margin = new Padding(0, 0, 10, 0), BackColor = Theme.Bg };
        var l = Skin.Lbl(label); l.AutoSize = false; l.Dock = DockStyle.Top; l.Height = 22; l.Font = Theme.Small;
        c.Dock = DockStyle.Top; Skin.Input(c);
        p.Controls.Add(c); p.Controls.Add(l);
        return p;
    }

    PlcSource CurSource => _opts[Math.Clamp(_proto.SelectedIndex, 0, _opts.Count - 1)].Src;   // Digital I/O: I/O của board = Unit 0 qua Modbus (RTU nội bộ trên board, TCP từ gateway PC)

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
            if (rtu && _board) { host.Text = "RS485"; host.Enabled = false; }   // board Waveshare: cổng RS485 gắn cứng trên mạch — không có tên COM để nhập, chỉ chọn baud/parity
            var port = new TextBox { Text = (conn?.Port > 0 ? conn.Port : ProtocolSpec.SuggestPort(src)).ToString() }; _connInputs["port"] = port;
            _rowConn.Controls.Add(Field(rtu ? (_board ? "Cổng (RS485 cố định trên board)" : "Cổng COM") : _tpl.BoardIo && !_board ? "IP của board Waveshare" : "Địa chỉ PLC (IP/tên máy)", host, 250));
            _rowConn.Controls.Add(Field(rtu ? "Baud" : "Cổng", port, 110));
        }
        foreach (var d in ProtocolSpec.ConnOptions(src)) AddInput(_rowConn, _connInputs, "Kết nối: " + d.Label, d, conn?.Opt(d.Key));
        foreach (var d in ProtocolSpec.Params(src)) AddInput(_rowParam, _paramInputs, d.Label, d, prm != null && prm.TryGetValue(d.Key, out var pv) ? pv : null);
        _rowConn.ResumeLayout(); _rowParam.ResumeLayout();
        _addrHint.Text = DeviceTemplate.AddressHint(src);
        WireChrome(HwOn);   // cũng áp dụng việc ẩn IP/cổng theo thiết bị đích
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
        T("Field", 80); T("Khoá MQTT", 96); T("Nhãn hiển thị", 120);
        var acc = new DataGridViewComboBoxColumn { HeaderText = "Quyền", Width = 84, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable }; acc.Items.AddRange(AccessNames); _g.Columns.Add(acc);
        var ty = new DataGridViewComboBoxColumn { HeaderText = "Kiểu", Width = 80, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable }; ty.Items.AddRange(TypeNames); _g.Columns.Add(ty);
        T("D", 50); T("Hệ số", 60); T("Đơn vị", 64); T("Min ghi", 60); T("Max ghi", 60);
        var kind = new DataGridViewComboBoxColumn { HeaderText = "Hiển thị", Width = 108, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable };
        kind.Items.AddRange(FieldMeta.KindNames); _g.Columns.Add(kind);
        T("Chữ khi Bật", 100); T("Chữ khi Tắt", 90); T("Ngưỡng thấp", 96); T("Ngưỡng cao", 92);
        // PHẢN HỒI THẬT: tên field ĐẦU VÀO (DI nối cảm biến / tiếp điểm relay) của cùng thiết bị. Webapp so lệnh với giá trị này
        // sau khi gửi — khớp = "đã xác nhận bằng cảm biến", lệch/không đổi = cảnh báo. Chỉ dùng cho dòng Công tắc ghi được.
        T("Phản hồi từ field", 120);
        // GHÉP VÀO SƠ ĐỒ (chỉ khi gateway đang dùng một giải pháp UI): chọn ô sơ đồ → đặt tên field = khoá của ô đó (gateway + webapp
        // cùng nhận theo tên field). "Widget riêng" = field giữ tên riêng, hiện thành thẻ widget ngoài sơ đồ.
        if (SolutionHost.Slots.Count > 0)
        {
            var slot = new DataGridViewComboBoxColumn { HeaderText = "Gắn vào sơ đồ", Width = 170, FlatStyle = FlatStyle.Flat, SortMode = DataGridViewColumnSortMode.NotSortable };
            slot.Items.Add(NoSlot); foreach (var x in SolutionHost.Slots) slot.Items.Add(SlotName(x));
            _g.Columns.Add(slot);
            _g.Columns[ColSlot].DisplayIndex = 1;   // đứng ngay sau cột Field cho dễ thấy
            _g.CellValueChanged += (_, e) =>
            {
                if (e.RowIndex < 0 || _syncingSlot) return;
                var r = _g.Rows[e.RowIndex];
                if (e.ColumnIndex == ColSlot)
                {
                    var name = Convert.ToString(r.Cells[ColSlot].Value) ?? NoSlot;
                    var sl = SolutionHost.Slots.FirstOrDefault(x => SlotName(x) == name);
                    if (sl.Keys == null) return;   // "Widget riêng": giữ nguyên tên field
                    _syncingSlot = true;
                    r.Cells[ColField].Value = sl.Keys[0];
                    r.Cells[ColMqtt].Value = "";   // khoá MQTT riêng sẽ làm webapp nhận tên khác → bỏ để webapp ghép đúng ô
                    if (string.IsNullOrWhiteSpace(Convert.ToString(r.Cells[ColTitle].Value))) r.Cells[ColTitle].Value = sl.Label;
                    if (string.IsNullOrWhiteSpace(Convert.ToString(r.Cells[ColUnit].Value)) && sl.Unit.Length > 0) r.Cells[ColUnit].Value = sl.Unit;
                    _syncingSlot = false;
                }
                else if (e.ColumnIndex is ColField or ColMqtt) SyncSlot(r);
            };
            _g.RowsAdded += (_, e) => { for (var i = e.RowIndex; i < e.RowIndex + e.RowCount && i < _g.Rows.Count; i++) SyncSlot(_g.Rows[i]); };
        }
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
        if (!t.Wire && DioSel) { _proto.SelectedIndex = Math.Min(1, _opts.Count - 1); return; }   // handler gọi lại PickTemplate với giao thức thường (RS485 / Modbus)
        foreach (var x in _tiles) { x.Selected = x.Tpl == t; x.Invalidate(); }
        if (!fill) return;
        if (!_childTouched || string.IsNullOrWhiteSpace(_child.Text)) { _child.Text = UniqueChild(t.IdPrefix); _childTouched = false; }
        _title.Text = t.DefaultTitle;
        _g.Rows.Clear();
        _wire.Visible = HwOn; _wNote.Visible = _wDoBox.Visible = _wDiBox.Visible = HwOn;
        if (HwOn && t.HwInputOnly) _wDoBox.Visible = false;
        if (!HwOn) WireChrome(false);
        if (HwOn)
        {
            BoardProto();
            _wBusy = true; FillPins(t.HwInputOnly); _wBusy = false;
            UpdateWireUi(); ApplyWire();
            return;
        }
        var used = UsedElsewhere(); var next = 50;
        foreach (var f in t.Fields)
        {
            var addr = next;
            if (f.Addr >= 0) addr = f.Addr;   // I/O trên board: địa chỉ cố định
            else { while (used.Contains(next) && next < Contract.MaxRegister - 1) next++; used.Add(next); addr = next; }
            var ki = Math.Max(0, Array.IndexOf(FieldMeta.Kinds, f.Kind));
            _g.Rows.Add(f.Field, "", f.Label, f.Writable ? "Đọc/ghi" : "Chỉ đọc", "UINT", addr.ToString(), Num(f.Scale), f.Unit, f.Writable ? Num(f.Min) : "", f.Writable ? Num(f.Max) : "",
                FieldMeta.KindNames[ki], f.On, f.Off, f.Low is { } lo ? Num(lo) : "", f.High is { } hi ? Num(hi) : "");
        }
        if (t.BoardIo) BoardProto();
    }

    /// <summary>Chân DI/DO của board là I/O nội bộ — gateway chạy độc lập, không cần PLC. Ẩn giao thức/cổng/baud/unit (đã tự đặt), chỉ giữ Lọc rung DI.</summary>
    /// <summary>Waveshare: IP do ô "Thiết bị đích" quyết định (cổng 502 cố định từ PC); trên board RS485 gắn cứng (không có tên cổng) — các ô này ẩn.</summary>
    bool HiddenNet(string key) => key switch { "host" => WaveshareTarget, "port" => WaveshareTarget && !_board, _ => false };

    void WireChrome(bool standalone)
    {
        _addrHint.Visible = !standalone;   // ô Giao thức luôn hiện: chính nó chọn "Digital I/O"
        // Digital I/O không có thanh ghi Modbus để khai báo: ẩn bảng field (tên field, khoá MQTT, D, hệ số, kiểu…), thứ tự word và lời giải thích của Modbus.
        // Dữ liệu vẫn nằm trong bảng (dựng từ chân đã chọn) để lưu; chỉ không hiện ra.
        _g.Visible = !standalone; _hintLbl.Visible = !standalone; if (_swap.Parent != null) _swap.Parent.Visible = !standalone;
        // Digital I/O (standalone): chỉ giữ Lọc rung DI trên board; từ PC không còn gì để nhập (IP lấy từ "Thiết bị đích").
        // IP/cổng chỉ hiện cho giao thức đi qua mạng (Modbus TCP tới thiết bị bất kỳ): giao thức của Waveshare (DI/DO, RS485) không phải nhập IP.
        foreach (var c in _connInputs.Concat(_paramInputs)) if (c.Value.Parent != null) c.Value.Parent.Visible = (!standalone || (_board && c.Key == "difilter")) && !HiddenNet(c.Key);
        _rowParam.Visible = !standalone;
    }

    /// <summary>I/O của board = Unit ID 0. Cấu hình trên board: Modbus RTU (nội bộ). Từ gateway PC: Modbus TCP tới IP board (cổng 502) — board là slave, PC tự giữ lease.</summary>
    void BoardProto()
    {
        if (_paramInputs.TryGetValue("unit", out var u)) u.Text = "0";
        if (_board && _connInputs.TryGetValue("host", out var h) && string.IsNullOrWhiteSpace(h.Text)) h.Text = "RS485";
        if (!_board && _connInputs.TryGetValue("port", out var p) && (p.Text.Trim() is "" or "0")) p.Text = "502";
    }

    static string[] PinNames(string p) => Enumerable.Range(1, 8).Select(i => p + i).ToArray();

    /// <summary>Danh sách DI1..DI8 / DO1..DO8; chân đã có thiết bị khác dùng (cùng Modbus RTU Unit 0) được đánh dấu và không chọn mặc định.</summary>
    void FillPins(bool inputOnly = false)
    {
        var used = UsedElsewhere();
        void Fill(ComboBox cb, string p, int baseAddr, bool pick)
        {
            cb.Items.Clear(); cb.Items.Add(NoPin);
            for (var i = 0; i < 8; i++) cb.Items.Add(used.Contains(baseAddr + i) ? $"{p}{i + 1}  (đã dùng)" : $"{p}{i + 1}");
            var free = Enumerable.Range(0, 8).Where(i => !used.Contains(baseAddr + i)).Select(i => i + 1).FirstOrDefault();
            cb.SelectedIndex = pick ? free : 0;   // mặc định: có DO điều khiển, DI phản hồi để trống (loại chỉ đọc: DI đầu tiên còn rảnh)
        }
        Fill(_wDi, "DI", 10, inputOnly); Fill(_wDo, "DO", 20, !inputOnly);
    }

    void UpdateWireUi()
    {
        var hasDo = _wDo.SelectedIndex > 0; var hasDi = _wDi.SelectedIndex > 0;
        _wNote.Text = (_board ? "Board chạy độc lập, không cần PLC. " : "Nhập IP của board Waveshare: gateway PC này tự giữ lease nên board chuyển sang chế độ gateway (Modbus TCP slave, tạm dừng MQTTS). ") + (hasDo, hasDi) switch
        {
            (true, true) => "Điều khiển + phản hồi: 1 thiết bị gồm công tắc ghi DO (lệnh) và DI (kết quả thật nhận về). Webapp so lệnh với DI sau khi gửi: khớp = đã xác nhận, lệch = cảnh báo.",
            (true, false) => "Điều khiển: chỉ GHI chân DO, không có tín hiệu xác nhận trở lại (bỏ chọn DI).",
            (false, true) => "Cảm biến: chỉ ĐỌC tín hiệu 0/1 từ chân DI đã chọn.",
            _ => _tpl.HwInputOnly ? "Chọn chân DI để đọc tín hiệu." : "Chọn ít nhất một chân: DO để điều khiển, DI để đọc / phản hồi. Chỉ nối công tắc bật/tắt; các field khác (tốc độ…) cần khai báo PLC — bỏ tick để khai báo đầy đủ.",
        };
    }

    /// <summary>Dựng lại các dòng field theo kiểu và chân đã chọn: DIn = D10+n−1 (đọc), DOn = D20+n−1 (đọc/ghi).</summary>
    void ApplyWire()
    {
        if (!HwOn) return;
        var di = _wDi.SelectedIndex; var dout = _wDo.SelectedIndex;   // 0 = không dùng, n = chân n
        var tk = Array.IndexOf(FieldMeta.Kinds, "toggle"); var kn = FieldMeta.KindNames[Math.Max(0, tk)];
        var f = _tpl.Fields.First(x => x.Field == _tpl.HwField);   // field chính của loại thiết bị (run / on / open / out / in): giữ đúng tên để thẻ + webapp hiện như thiết bị thật
        var fb = f.Field + "_fb";
        _g.Rows.Clear();
        if (_tpl.HwInputOnly)
        {
            if (di > 0) _g.Rows.Add(f.Field, "", f.Label, "Chỉ đọc", "UINT", (10 + di - 1).ToString(), "1", "", "", "", kn, "Có tín hiệu", "Không", "", "", "");
        }
        else
        {
            if (dout > 0) _g.Rows.Add(f.Field, "", f.Label, "Đọc/ghi", "UINT", (20 + dout - 1).ToString(), "1", "", "0", "1", kn, f.On, f.Off, "", "", di > 0 ? fb : "");
            if (di > 0) _g.Rows.Add(dout > 0 ? fb : f.Field, "", dout > 0 ? $"Phản hồi DI{di}" : f.Label, "Chỉ đọc", "UINT", (10 + di - 1).ToString(), "1", "", "", "", kn, f.On, f.Off, "", "", "");
        }
        var pin = _tpl.HwInputOnly ? (di > 0 ? $"DI{di}" : "") : dout > 0 && di > 0 ? $"DO{dout} / DI{di}" : dout > 0 ? $"DO{dout}" : di > 0 ? $"DI{di}" : "";
        var t = pin.Length > 0 ? $"{_tpl.DefaultTitle} ({pin})" : _tpl.DefaultTitle;
        if (_title.Text == _autoTitle || _title.Text == _tpl.DefaultTitle || _title.Text.StartsWith(_tpl.DefaultTitle + " (")) { _title.Text = t; _autoTitle = t; }
        WireChrome(true);
    }

    /// <summary>Mã chưa dùng: giữ nguyên nếu rảnh, trùng thì thêm số _2, _3…</summary>
    string UniqueChildName(string baseName)
    {
        var used = _app.Config.Pack.Select(p => p.Child).ToHashSet();
        if (!used.Contains(baseName)) return baseName;
        for (var i = 2; ; i++) { var c = baseName.Length + 1 + i.ToString().Length > 48 ? baseName[..(48 - 1 - i.ToString().Length)] + "_" + i : baseName + "_" + i; if (!used.Contains(c)) return c; }
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
        var ii = Array.FindIndex(IconChoices, t => t.Icon == dm?.Icon);
        _icon.SelectedIndex = string.IsNullOrEmpty(dm?.Icon) || ii < 0 ? 0 : ii + 1;
        _color.SelectedIndex = Math.Max(0, Array.IndexOf(DeviceStyle.ColorKeys, dm?.Color ?? ""));
        var first = _app.Config.Pack.First(x => x.Child == child);
        SelectSource(first.Source ?? _app.Config.Source);
        RebuildBind(null, first.IsBound ? first.Params : null);
        _swap.SelectedIndex = first.WordSwap ? 1 : 0;
        foreach (var p in _app.Config.Pack.Where(x => x.Child == child))
        {
            var m = _app.Meta.Get(child, p.Field);
            var r = FieldMeta.ResolveFull(p, m);
            var ki = Math.Max(0, Array.IndexOf(FieldMeta.Kinds, r.Kind));
            _g.Rows.Add(p.Field, p.MqttKey, m?.Title ?? "", AccessNames[(int)p.Access], TypeNames[(int)p.DataType], p.Address >= 0 ? p.Address.ToString() : "", p.Scale > 0 ? Num(p.Scale) : "", r.Unit,
                p.Min is { } a ? Num(a) : "", p.Max is { } b ? Num(b) : "",
                FieldMeta.KindNames[ki], m?.OnText ?? "", m?.OffText ?? "", m?.Low is { } lo ? Num(lo) : "", m?.High is { } hi ? Num(hi) : "", m?.Feedback ?? "");
        }
    }

    static string Cell(DataGridViewRow r, int c) => (Convert.ToString(r.Cells[c].Value) ?? "").Trim();

    bool _syncingSlot;
    static string SlotName((string Label, string Unit, string[] Keys) s) => $"{s.Label} ({s.Keys[0]})";
    /// <summary>Hiện ô sơ đồ tương ứng tên field (khoá MQTT riêng khác tên → webapp không ghép được → coi như widget riêng).</summary>
    void SyncSlot(DataGridViewRow r)
    {
        if (SolutionHost.Slots.Count == 0 || r.IsNewRow || _g.Columns.Count <= ColSlot) return;
        var f = Cell(r, ColField); var mk = Cell(r, ColMqtt);
        var sl = mk.Length > 0 && !string.Equals(mk, f, StringComparison.OrdinalIgnoreCase) ? default
            : SolutionHost.Slots.FirstOrDefault(x => x.Keys.Contains(f, StringComparer.OrdinalIgnoreCase));
        _syncingSlot = true;
        r.Cells[ColSlot].Value = sl.Keys == null ? NoSlot : SlotName(sl);
        _syncingSlot = false;
    }

    static bool TryNum(string s, out double? v)
    {
        v = null; if (s.Length == 0) return true;
        if (!double.TryParse(s.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return false;
        v = d; return true;
    }

    void Commit()
    {
        // ô bảng đang gõ dở (chưa Enter) phải được chốt trước khi đọc, nếu không giá trị mới (vd. thanh ghi D) bị bỏ sót và giữ giá trị cũ
        _g.EndEdit();
        var rx = new Regex("^[A-Za-z0-9_-]{1,48}$");
        if (!_app.RequireEdit()) return;   // hộp thoại có thể mở quá 5 phút: kiểm tra lại phiên sửa ngay lúc lưu
        var child = _child.Text.Trim();
        if (!rx.IsMatch(child))   // mã gõ có dấu/ký tự lạ (vd. "Bồn nước 1"): tự bỏ dấu thay vì từ chối
        {
            var slug = Vn.Slug(child, 48, allowDash: true);
            if (slug.Length == 0) { _err.Text = "Mã thiết bị cần ít nhất một chữ hoặc số (tên tiếng Việt thì nhập ở ô Tên hiển thị)."; return; }
            child = slug; _child.Text = slug;
        }
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

        var used = UsedElsewhere(); var names = new HashSet<string>(); var wires = new HashSet<string>();
        var swap = _swap.SelectedIndex == 1;
        var packs = new List<(PackMap P, FieldMeta M)>();
        foreach (var r in rows)
        {
            var f = Cell(r, ColField); var line = r.Index + 1;
            if (!rx.IsMatch(f))   // field gõ tiếng Việt: tự bỏ dấu, nhãn tiếng Việt đã có ở cột "Nhãn hiển thị"
            {
                var fs = Vn.Slug(f, 48, allowDash: true);
                if (fs.Length == 0) { _err.Text = $"Dòng {line}: field cần ít nhất một chữ hoặc số (nhãn tiếng Việt nhập ở cột Nhãn hiển thị)."; return; }
                f = fs; r.Cells[ColField].Value = fs;
            }
            if (!names.Add(f)) { _err.Text = $"Dòng {line}: field \"{f}\" bị trùng."; return; }
            var mk = Cell(r, ColMqtt);
            if (mk.Length > 0 && !Regex.IsMatch(mk, "^[A-Za-z0-9_]{1,32}$"))
            {
                var ms = Vn.Slug(mk, 32);
                if (ms.Length == 0) { _err.Text = $"Dòng {line}: khoá MQTT cần ít nhất một chữ hoặc số (tối đa 32 ký tự)."; return; }
                mk = ms; r.Cells[ColMqtt].Value = ms;
            }
            if (!wires.Add(mk.Length > 0 ? mk : f)) { _err.Text = $"Dòng {line}: khoá MQTT \"{(mk.Length > 0 ? mk : f)}\" bị trùng trong thiết bị."; return; }
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
            var fb = Cell(r, ColFb);
            if (fb.Length > 0)
            {
                // cùng thiết bị, khác chính nó, và chính dòng này phải là công tắc ghi được thì mới có "lệnh" để đối chiếu
                if (fb == f) { _err.Text = $"Dòng {line}: field phản hồi không được là chính nó."; return; }
                if ((PackAccess)ai == PackAccess.Read || (FieldMeta.Kinds[Math.Max(0, ki)] is not ("toggle" or "auto"))) { _err.Text = $"Dòng {line}: chỉ field ghi được dạng Công tắc mới có phản hồi."; return; }
            }
            packs.Add((new PackMap
                {
                    Child = child, Field = f, MqttKey = mk == f ? "" : mk, Address = addr, Scale = sc!.Value, Min = mn, Max = mx,
                    Protocol = src.ToString(), Access = (PackAccess)ai, DataType = type, WordSwap = swap, Params = new Dictionary<string, string>(prm),
                },
                new FieldMeta { Kind = FieldMeta.Kinds[Math.Max(0, ki)], Unit = Cell(r, ColUnit), Title = Cell(r, ColTitle), OnText = Cell(r, ColOn), OffText = Cell(r, ColOff), Low = lo, High = hi, Feedback = fb }));
        }
        foreach (var (p, m) in packs)
            if (m.Feedback.Length > 0 && !packs.Any(x => x.Item1.Field == m.Feedback)) { _err.Text = $"Field phản hồi \"{m.Feedback}\" của \"{p.Field}\" không có trong thiết bị này."; return; }

        // áp vào cấu hình
        foreach (var old in _app.Config.Pack.Where(p => p.Child == child).ToList()) { _app.Config.Pack.Remove(old); _app.Meta.Remove(child, old.Field); }
        foreach (var (p, m) in packs) { _app.Config.Pack.Add(p); _app.Meta.Set(child, p.Field, m); }
        _app.Config.Connections.RemoveAll(c => c.Protocol == src);
        _app.Config.Connections.Add(conn);
        _app.Meta.SetDevice(child, new DeviceMeta { Title = _title.Text.Trim(), Template = _tpl.Id, Icon = IconValue(), Color = DeviceStyle.ColorKeys[Math.Max(0, _color.SelectedIndex)] });
        DialogResult = DialogResult.OK; Close();
    }

    /// <summary>Tạo hộp thoại không hiện modal (để chụp ảnh kiểm tra giao diện).</summary>
    public static Form Preview(IGatewayApp app, string? editChild) => new DeviceDialog(app, editChild);

    /// <summary>Mở hộp thoại thêm (editChild = null) hoặc sửa. Đúng = đã áp vào cấu hình, người gọi nên gọi ApplyAsync.</summary>
    public static bool Run(IGatewayApp app, IWin32Window owner, string? editChild, out string child) => Run(app, owner, editChild, out child, out _);

    public static bool Run(IGatewayApp app, IWin32Window owner, string? editChild, out string child, out bool deleted)
    {
        if (!app.RequireEdit()) { child = ""; deleted = false; return false; }   // sửa cấu hình cần OTP (một lần mỗi lần mở app)
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
    FlatButton? _runBtn;
    string _sig = "";

    public DevicesPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_g);
        foreach (var (n, h, w) in new[] { ("c", "Thiết bị", 160), ("f", "Field", 90), ("l", "Nhãn", 110), ("p", "Giao thức", 120), ("a", "Quyền", 70), ("t", "Kiểu", 60), ("d", "Thanh ghi", 90), ("s", "Hệ số", 50), ("lim", "Giới hạn ghi", 90), ("k", "Hiển thị", 90), ("u", "Đơn vị", 56), ("st", "Trạng thái", 90), ("v", "Giá trị hiện tại", 110) })
            _g.Columns.Add(new DataGridViewTextBoxColumn { Name = n, HeaderText = h, Width = w });
        _g.Columns[^1].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6) };
        var add = _addBtn = new FlatButton { Caption = "＋  Thêm thiết bị ngoại vi", Primary = true, Width = 210 };
        var edit = new FlatButton { Caption = "Sửa thiết bị", Width = 120 };
        var del = new FlatButton { Caption = "Xoá thiết bị", Width = 120, Danger = true };
        _runBtn = new FlatButton { Caption = "⏸  Tạm dừng thiết bị", Width = 200 };
        _runBtn.Click += async (_, _) => await ToggleRun();
        _g.SelectionChanged += (_, _) => UpdateRunBtn();
        add.Click += (_, _) => AddOrEdit(null);
        edit.Click += (_, _) => AddOrEdit(SelectedChild());
        del.Click += async (_, _) => await Delete();
        _g.CellDoubleClick += (_, e) => { if (e.RowIndex >= 0) AddOrEdit(SelectedChild()); };
        _g.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Delete) { e.Handled = true; await Delete(); } };
        bar.Controls.AddRange(new Control[] { add, edit, _runBtn, del });

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

    bool? IsEnabled(string? child) => child == null ? null : _app.Config.Pack.Where(p => p.Child == child).Select(p => (bool?)p.Enabled).FirstOrDefault();

    void UpdateRunBtn()
    {
        if (_runBtn == null) return;
        var en = IsEnabled(SelectedChild());
        _runBtn.Caption = en == false ? "▶  Chạy thiết bị" : "⏸  Tạm dừng thiết bị";
        _runBtn.Primary = en == false; _runBtn.Invalidate();
    }

    /// <summary>Chạy / tạm dừng việc nhận dữ liệu (đọc, ghi, gửi cloud) của thiết bị đang chọn. Có hiệu lực ngay.</summary>
    async Task ToggleRun()
    {
        var c = SelectedChild(); if (c == null) { _app.Toast("Chọn một dòng của thiết bị cần chạy hoặc tạm dừng.", true); return; }
        if (!_app.RequireEdit()) return;
        var err = await _app.SetDeviceEnabledAsync(c, IsEnabled(c) == false);
        if (err != null) _app.Toast($"Không đổi được trạng thái {c}: {err}", true);
        Refill();
    }

    async Task Delete()
    {
        var c = SelectedChild(); if (c == null) { _app.Toast("Chọn một dòng của thiết bị cần xoá.", true); return; }
        if (!_app.RequireEdit()) return;
        if (!DeviceDialog.ConfirmDelete(_app, FindForm(), c)) return;
        if (!_app.RequireEdit()) return;   // hộp xác nhận có thể mở lâu: kiểm tra lại phiên sửa trước khi xoá
        DeviceDialog.Remove(_app, c);
        Refill(); await _app.ApplyAsync($"Đã xoá thiết bị {c}");
    }

    string Sig() => string.Join("|", _app.Config.Pack.Select(p => $"{p.Child}.{p.Field}@{p.Address}x{p.Scale}[{p.Min}-{p.Max}]{p.Protocol}/{p.Access}/{p.DataType}/{p.Enabled}"))
        + string.Join("|", _app.Meta.Map.Select(kv => kv.Key + kv.Value.Kind + kv.Value.Unit + kv.Value.Title)) + string.Join("|", _app.Meta.Devices.Select(kv => kv.Key + kv.Value.Title));

    void Refill()
    {
        _sig = Sig();
        var keep = _g.CurrentRow?.Index ?? -1;
        _g.SuspendLayout();
        _g.CurrentCell = null;
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
                FieldMeta.KindNames[Math.Max(0, Array.IndexOf(FieldMeta.Kinds, r.Kind))], r.Unit, p.Enabled ? "Đang chạy" : "Tạm dừng", "—");
            _g.Rows[i].Cells[0].Tag = p.Child;
            if (!p.Enabled) _g.Rows[i].DefaultCellStyle.ForeColor = Theme.Muted;
        }
        if (keep >= 0 && keep < _g.Rows.Count) _g.CurrentCell = _g.Rows[keep].Cells[0];
        _g.ResumeLayout(true);
        _g.Invalidate();
        UpdateRunBtn();
    }

    public void Tick()
    {
        if (Sig() != _sig) Refill();
        foreach (DataGridViewRow r in _g.Rows)
        {
            var key = UiMetaStore.Key(Convert.ToString(r.Cells[0].Tag) ?? "", Convert.ToString(r.Cells[1].Value) ?? "");
            r.Cells[12].Value = _app.TryValue(key, out var v) ? Theme.Num(v) : "—";
        }
    }
}
