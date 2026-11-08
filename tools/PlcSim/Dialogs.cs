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
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190)); t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return t;
    }

    public static void Row(TableLayoutPanel t, string label, Control c)
    {
        t.Controls.Add(L(label)); c.Dock = DockStyle.Fill; c.Margin = new Padding(0, 3, 0, 3); t.Controls.Add(c);
        t.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
    }

    public static NumericUpDown Dec(decimal min, decimal max, int places = 3) => new() { Minimum = min, Maximum = max, DecimalPlaces = places };

    public static Form Shell(string title, Size size)
    {
        return new Form
        {
            Text = title, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
            StartPosition = FormStartPosition.CenterParent, ClientSize = size, Font = new Font("Segoe UI", 9.5f),
        };
    }
}

/// <summary>Thêm / sửa một luồng dữ liệu: thiết bị.field ↔ thanh ghi D + cách sinh giá trị.</summary>
sealed class StreamDialog : IDisposable
{
    readonly Form _f;
    readonly ComboBox _child = new() { DropDownStyle = ComboBoxStyle.DropDown };
    readonly TextBox _field = new();
    readonly NumericUpDown _addr = new() { Minimum = 0, Maximum = PlcModel.Size - 1 };
    readonly NumericUpDown _scale = DlgUi.Dec(0.001m, 100000);
    readonly ComboBox _mode = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly NumericUpDown _value = DlgUi.Dec(-1_000_000, 1_000_000), _min = DlgUi.Dec(-1_000_000, 1_000_000), _max = DlgUi.Dec(-1_000_000, 1_000_000);
    readonly NumericUpDown _period = DlgUi.Dec(1, 86400, 1), _step = DlgUi.Dec(-100000, 100000);
    readonly Label _hint = new() { AutoSize = false, Height = 54, Dock = DockStyle.Top, ForeColor = Color.DimGray, Padding = new Padding(16, 6, 16, 0) };
    readonly Label _err = new() { AutoSize = false, Height = 22, Dock = DockStyle.Bottom, ForeColor = Color.Firebrick, Padding = new Padding(16, 0, 16, 0) };
    readonly HashSet<int> _used;
    readonly HashSet<(string, string)> _existing;
    readonly bool _edit;
    static readonly PlcModel.FieldMode[] Modes = { PlcModel.FieldMode.Fixed, PlcModel.FieldMode.Random, PlcModel.FieldMode.Sine, PlcModel.FieldMode.Ramp, PlcModel.FieldMode.Sim };
    static readonly string[] Names =
    {
        "Cố định (một số)", "Ngẫu nhiên trong khoảng Min–Max", "Sóng sin giữa Min–Max", "Tăng dần từ Min tới Max rồi quay lại", "Mô phỏng bồn nước (level/flow/hours)",
    };

    public string Child => _child.Text.Trim();
    public string Field => _field.Text.Trim();
    public int Addr => (int)_addr.Value;
    public double Scale => (double)_scale.Value;
    public double Value => (double)_value.Value;
    public PlcModel.Gen Gen => new(Modes[Math.Max(0, _mode.SelectedIndex)], (double)_min.Value, (double)_max.Value, (double)_period.Value, (double)_step.Value);

    public StreamDialog(string? child, string? field, int addr, double scale, PlcModel.Gen gen, double value, HashSet<int> used, string[] children, HashSet<(string, string)> existing, bool edit)
    {
        _used = used; _existing = existing; _edit = edit;
        _f = DlgUi.Shell(edit ? $"Sửa luồng {child}.{field}" : "Thêm luồng dữ liệu", new Size(560, 540));
        _mode.Items.AddRange(Names);
        foreach (var c in children) _child.Items.Add(c);
        var t = DlgUi.Table();
        DlgUi.Row(t, "Thiết bị (child)", _child);
        DlgUi.Row(t, "Field", _field);
        DlgUi.Row(t, "Thanh ghi D", _addr);
        DlgUi.Row(t, "Hệ số (D = giá trị × hệ số)", _scale);
        DlgUi.Row(t, "Cách sinh giá trị", _mode);
        DlgUi.Row(t, "Giá trị cố định", _value);
        DlgUi.Row(t, "Min", _min);
        DlgUi.Row(t, "Max", _max);
        DlgUi.Row(t, "Chu kỳ sóng sin (giây)", _period);
        DlgUi.Row(t, "Bước tăng mỗi giây", _step);
        _hint.Text = "Child/field phải trùng tem trên server nếu dùng cloud. Gateway đọc thanh ghi D rồi chia hệ số. Giao thức MQTT gửi thẳng d.<child>.<field> nên bỏ qua D. Ngẫu nhiên/sóng sin/tăng dần chạy khi bật \"Chạy mô phỏng giá trị\".";
        var ok = new Button { Text = edit ? "Lưu" : "Thêm", Width = 100, Height = 32, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "Huỷ", Width = 90, Height = 32, DialogResult = DialogResult.Cancel };
        ok.Click += (_, _) => Commit();
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10, 8, 10, 0) };
        bar.Controls.Add(cancel); bar.Controls.Add(ok);
        _f.Controls.Add(t); _f.Controls.Add(_hint); _f.Controls.Add(_err); _f.Controls.Add(bar);
        _f.Controls.SetChildIndex(t, 3); _f.Controls.SetChildIndex(_hint, 2);
        _f.CancelButton = cancel;

        _child.Text = child ?? (children.Length > 0 ? "" : "tank1"); _field.Text = field ?? "";
        if (edit) { _child.Enabled = false; _field.Enabled = false; }
        _addr.Value = addr >= 0 ? addr : NextFree();
        _scale.Value = (decimal)Math.Clamp(scale, 0.001, 100000);
        _mode.SelectedIndex = Math.Max(0, Array.IndexOf(Modes, gen.Mode));
        _value.Value = (decimal)Math.Clamp(value, -1_000_000, 1_000_000);
        _min.Value = (decimal)Math.Clamp(gen.Min, -1_000_000, 1_000_000); _max.Value = (decimal)Math.Clamp(gen.Max, -1_000_000, 1_000_000);
        _period.Value = (decimal)Math.Clamp(gen.Period, 1, 86400); _step.Value = (decimal)Math.Clamp(gen.Step, -100000, 100000);
        _mode.SelectedIndexChanged += (_, _) => UpdateState();
        UpdateState();
    }

    int NextFree() { var n = 50; while (_used.Contains(n) && n < PlcModel.Size - 1) n++; return n; }

    void UpdateState()
    {
        var m = Modes[Math.Max(0, _mode.SelectedIndex)];
        _value.Enabled = m == PlcModel.FieldMode.Fixed;
        _min.Enabled = _max.Enabled = m is PlcModel.FieldMode.Random or PlcModel.FieldMode.Sine or PlcModel.FieldMode.Ramp;
        _period.Enabled = m == PlcModel.FieldMode.Sine;
        _step.Enabled = m == PlcModel.FieldMode.Ramp;
    }

    void Commit()
    {
        var rx = new Regex("^[A-Za-z0-9_-]{1,48}$");
        if (!rx.IsMatch(Child) || !rx.IsMatch(Field)) { _err.Text = "Thiết bị/field chỉ gồm chữ, số, _ và -, tối đa 48 ký tự."; return; }
        if (!_edit && _existing.Contains((Child, Field))) { _err.Text = "Luồng này đã có."; return; }
        if (_used.Contains(Addr)) { _err.Text = $"D{Addr} đã được luồng khác dùng."; return; }
        var g = Gen;
        if (g.Mode is PlcModel.FieldMode.Random or PlcModel.FieldMode.Sine or PlcModel.FieldMode.Ramp && g.Min > g.Max) { _err.Text = "Min không được lớn hơn Max."; return; }
        _f.DialogResult = DialogResult.OK; _f.Close();
    }

    public DialogResult ShowDialog(IWin32Window owner) => _f.ShowDialog(owner);
    public void Dispose() => _f.Dispose();
}

/// <summary>Chọn giao thức Ethernet và thông số kết nối.</summary>
sealed class ProtocolDialog : IDisposable
{
    readonly Form _f;
    readonly (string Label, string Kind, int Port, string HostLabel, string Hint)[] _protos;
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TextBox _host = new(), _site = new(), _device = new(), _user = new(), _pass = new() { UseSystemPasswordChar = true }, _tag = new();
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535 };
    readonly NumericUpDown _interval = new() { Minimum = 200, Maximum = 600000, Increment = 100 };
    readonly Label _hostLbl = DlgUi.L("Địa chỉ"), _hint = new() { AutoSize = false, Height = 70, Dock = DockStyle.Top, ForeColor = Color.DimGray, Padding = new Padding(16, 6, 16, 0) };
    readonly List<Control> _mqttOnly = new(), _tagOnly = new();
    bool _loading = true;

    public int ProtoIndex => _proto.SelectedIndex;
    public string Host => _host.Text.Trim();
    public int Port => (int)_port.Value;
    public string Site => _site.Text.Trim();
    public string Device => _device.Text.Trim();
    public string User => _user.Text.Trim();
    public string Pass => _pass.Text;
    public string Tag => _tag.Text.Trim();
    public int IntervalMs => (int)_interval.Value;

    public ProtocolDialog((string Label, string Kind, int Port, string HostLabel, string Hint)[] protos, int idx, string host, int port, string site, string device, string user, string pass, string tag, int interval)
    {
        _protos = protos;
        _f = DlgUi.Shell("Giao thức Ethernet", new Size(600, 560));
        foreach (var p in protos) _proto.Items.Add(p.Label);
        var t = DlgUi.Table();
        DlgUi.Row(t, "Giao thức", _proto);
        t.Controls.Add(_hostLbl); _host.Dock = DockStyle.Fill; _host.Margin = new Padding(0, 3, 0, 3); t.Controls.Add(_host); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        DlgUi.Row(t, "Cổng", _port);
        void Mq(string label, Control c) { var l = DlgUi.L(label); t.Controls.Add(l); c.Dock = DockStyle.Fill; c.Margin = new Padding(0, 3, 0, 3); t.Controls.Add(c); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); _mqttOnly.Add(l); _mqttOnly.Add(c); }
        Mq("Site (MQTT)", _site); Mq("Device (MQTT)", _device); Mq("MQTT user", _user); Mq("MQTT password", _pass); Mq("Chu kỳ gửi (ms)", _interval);
        var tl = DlgUi.L("Tên tag / symbol"); t.Controls.Add(tl); _tag.Dock = DockStyle.Fill; _tag.Margin = new Padding(0, 3, 0, 3); t.Controls.Add(_tag); t.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        _tagOnly.Add(tl); _tagOnly.Add(_tag);

        var note = new Label
        {
            Text = "Phiên bản này chỉ mô phỏng giao thức qua Ethernet (Modbus TCP, Mitsubishi MC, Omron FINS, Siemens S7, EtherNet/IP, OPC UA, Beckhoff ADS, MQTT).",
            AutoSize = false, Height = 40, Dock = DockStyle.Bottom, ForeColor = Color.DimGray, Padding = new Padding(16, 0, 16, 0),
        };
        var ok = new Button { Text = "Lưu", Width = 100, Height = 32, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Huỷ", Width = 90, Height = 32, DialogResult = DialogResult.Cancel };
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10, 8, 10, 0) };
        bar.Controls.Add(cancel); bar.Controls.Add(ok);
        _f.Controls.Add(t); _f.Controls.Add(_hint); _f.Controls.Add(note); _f.Controls.Add(bar);
        _f.Controls.SetChildIndex(t, 3); _f.Controls.SetChildIndex(_hint, 2);
        _f.AcceptButton = ok; _f.CancelButton = cancel;

        _proto.SelectedIndex = Math.Clamp(idx, 0, protos.Length - 1);
        _host.Text = host; _port.Value = Math.Clamp(port, 1, 65535); _site.Text = site; _device.Text = device; _user.Text = user; _pass.Text = pass; _tag.Text = tag;
        _interval.Value = Math.Clamp(interval, 200, 600000);
        _loading = false;
        _proto.SelectedIndexChanged += (_, _) => OnProto(true);
        OnProto(false);
    }

    void OnProto(bool reset)
    {
        var p = _protos[_proto.SelectedIndex];
        _hostLbl.Text = p.HostLabel; _hint.Text = p.Hint;
        if (reset && !_loading) { _port.Value = p.Port; _host.Text = p.Kind == "mqtt" ? "127.0.0.1" : "0.0.0.0"; }
        foreach (var c in _mqttOnly) c.Visible = p.Kind == "mqtt";
        foreach (var c in _tagOnly) c.Visible = p.Kind is "eip" or "ads";
        if (p.Kind == "ads" && _tag.Text is "PLC_D" or "") _tag.Text = "GVL_PLC.D";
        if (p.Kind == "eip" && _tag.Text is "GVL_PLC.D" or "") _tag.Text = "PLC_D";
    }

    public DialogResult ShowDialog(IWin32Window owner) => _f.ShowDialog(owner);
    public void Dispose() => _f.Dispose();
}
