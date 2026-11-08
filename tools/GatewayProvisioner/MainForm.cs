
namespace GatewayProvisioner;

public sealed class MainForm : Form
{
    readonly Settings _s = Settings.Load();
    readonly TextBox _vps = new(), _token = new() { UseSystemPasswordChar = true },
        _site = new(), _device = new(), _profile = new(), _request = new() { CharacterCasing = CharacterCasing.Upper },
        _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly ComboBox _gw = new() { DropDownStyle = ComboBoxStyle.DropDown };
    static readonly (string Id, string Title)[] Kinds =
    {
        ("mcu", "Gateway MCU (firmware, nối USB/LAN)"),
        ("pc", "Gateway PC (phần mềm cài trên máy khách)"),
        ("generic", "Gateway mua sẵn (chỉ cấu hình topic MQTT)"),
    };
    readonly ComboBox _kind = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly CheckBox _offline = new() { Text = "Gateway KHÔNG có internet (chỉ mạng LAN)", AutoSize = true };
    readonly Label _hint = new() { AutoSize = true, ForeColor = Color.DimGray, MaximumSize = new Size(480, 0) };
    readonly NumericUpDown _days = new() { Minimum = 0, Maximum = 3650 };
    readonly CheckBox _remember = new() { Text = "Nhớ token trên máy này (mã hoá bằng tài khoản Windows)", AutoSize = true, Checked = true };
    readonly Button _read = new() { Text = "Lấy mã từ gateway", AutoSize = true };
    readonly Button _go = new() { Text = "Nạp gateway", AutoSize = true, Font = new Font("Segoe UI", 11, FontStyle.Bold) };
    readonly Label _status = new() { AutoSize = true, Font = new Font("Segoe UI", 12, FontStyle.Bold), Padding = new Padding(0, 8, 0, 8) };

    public MainForm()
    {
        Text = "Nạp gateway – kết nối VPS";
        Font = new Font("Segoe UI", 10);
        MinimumSize = new Size(640, 640);
        Size = new Size(720, 720);

        _vps.Text = _s.Vps; _token.Text = _s.GetToken();
        foreach (var n in System.IO.Ports.SerialPort.GetPortNames().OrderBy(x => x)) _gw.Items.Add(n);
        foreach (var k in Kinds) _kind.Items.Add(k.Title);
        _kind.SelectedIndex = Math.Max(0, Array.FindIndex(Kinds, k => k.Id == _s.Kind));
        _offline.Checked = _s.Offline;
        _gw.Text = _s.Gateway;
        _site.Text = _s.Site; _device.Text = _s.Device; _profile.Text = _s.Profile; _days.Value = _s.Days;
        _request.Font = new Font("Consolas", 14, FontStyle.Bold);
        _log.Font = new Font("Consolas", 9.5f);

        var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(14), AutoScroll = true };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Row(string label, Control c)
        {
            t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            t.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Padding = new Padding(0, 8, 0, 0) });
            c.Dock = DockStyle.Fill; c.Margin = new Padding(3, 4, 3, 4);
            t.Controls.Add(c);
        }
        Row("Địa chỉ VPS", _vps);
        Row("Token nạp (admin cấp)", _token);
        Row("", _remember);
        Row("Kết nối gateway (COM3 / tcp://ip:port / http://ip)", _gw);
        Row("Loại gateway", _kind);
        Row("", _offline);
        Row("", _hint);
        Row("Nhà máy (site)", _site);
        Row("Mã thiết bị (device)", _device);
        Row("Loại (profile)", _profile);
        Row("Hạn dùng (ngày, 0 = không hết hạn)", _days);
        Row("Mã yêu cầu từ gateway (bỏ trống nếu không kích hoạt)", _request);

        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
        buttons.Controls.AddRange(new Control[] { _read, _go });
        Row("", buttons);
        Row("", _status);
        t.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        t.Controls.Add(new Label { Text = "Nhật ký", AutoSize = true, Padding = new Padding(0, 8, 0, 0) });
        t.Controls.Add(_log);
        Controls.Add(t);

        _kind.SelectedIndexChanged += (_, _) => UpdateHint();
        _offline.CheckedChanged += (_, _) => UpdateHint();
        UpdateHint();
        _read.Click += async (_, _) => await ReadAsync();
        _go.Click += async (_, _) => await GoAsync();
        _request.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await GoAsync(); } };
        FormClosing += (_, _) => Persist();
    }

    void Persist()
    {
        _s.Vps = _vps.Text.Trim(); _s.Gateway = _gw.Text.Trim(); _s.Kind = Kinds[Math.Max(0, _kind.SelectedIndex)].Id; _s.Offline = _offline.Checked; _s.Site = _site.Text.Trim();
        _s.Device = _device.Text.Trim(); _s.Profile = _profile.Text.Trim(); _s.Days = (int)_days.Value;
        _s.SetToken(_remember.Checked ? _token.Text.Trim() : "");
        try { _s.Save(); } catch { /* không lưu được cũng không sao */ }
    }

    string KindId => Kinds[Math.Max(0, _kind.SelectedIndex)].Id;

    /// <summary>Giải thích ngắn: với lựa chọn hiện tại thì tool làm gì và cần nhập gì.</summary>
    void UpdateHint()
    {
        var p = Plan.For(KindId, _offline.Checked, false);
        _hint.Text = p.Error != null ? "Gateway mua sẵn không hỗ trợ chế độ không internet."
            : (KindId, _offline.Checked) switch
            {
                ("mcu", false) => "Nạp QR + cấu hình MQTT vào MCU qua cổng COM hoặc LAN. Không cần mã kích hoạt.",
                ("mcu", true) => "Nạp QR + cấu hình, kèm mã kích hoạt theo mã yêu cầu MCU đang hiển thị (bấm \"Lấy mã từ gateway\").",
                ("pc", false) => "Ghi kit ra file (kết nối: file:C:\\kit\\gw01.json). Gateway PC tự gắn với tem khi enroll lần đầu; không cần nhập gì.",
                ("pc", true) => "Nhập ID máy hiện trên màn hình kích hoạt của PC khách. Tool ghi file kit + file giấy phép (kết nối: file:C:\\kit\\gw01.json).",
                _ => "Nạp QR + topic MQTT cho thiết bị mua sẵn. Không kích hoạt.",
            };
        _read.Enabled = _go.Enabled && p.Mode == "challenge";
    }

    void Log(string m) { _log.AppendText(m + Environment.NewLine); }

    void SetStatus(string text, bool ok)
    {
        _status.Text = text;
        _status.ForeColor = ok ? Color.FromArgb(0, 120, 60) : Color.Firebrick;
    }

    async Task ReadAsync()
    {
        _read.Enabled = false;
        try
        {
            var r = await Provisioner.ReadRequestAsync(_gw.Text);
            _request.Text = r;
            SetStatus("Đã đọc mã yêu cầu từ gateway.", true);
            Log($"Đã đọc từ gateway: {r}");
        }
        catch (Exception e) { SetStatus(e.Message, false); Log(e.Message); }
        finally { _read.Enabled = true; }
    }

    async Task GoAsync()
    {
        if (!_go.Enabled) return;
        _go.Enabled = _read.Enabled = false;
        SetStatus("Đang nạp…", true);
        try
        {
            Persist();
            var r = await Provisioner.RunAsync(new Options(
                _vps.Text, _token.Text, _gw.Text, _site.Text, _device.Text, _profile.Text,
                (int)_days.Value, _request.Text, false, KindId, _offline.Checked), Log);
            SetStatus(r.Message, r.Ok);
            Log((r.Ok ? "OK: " : "LỖI: ") + r.Message);
            if (r.Ok) _request.Clear();
        }
        finally { _go.Enabled = true; UpdateHint(); }
    }
}
