using System.Globalization;
using System.Text.Json;
using PlcSim.Protocols;

namespace PlcSim;

public sealed class MainForm : Form
{
    sealed record ProtoInfo(string Label, string Kind, int Port, string HostLabel, string GatewayHint);

    static readonly ProtoInfo[] Protos =
    {
        new("Modbus TCP (slave)", "modbus", 502, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = ModbusTcp, PlcHost = IP máy này, PlcPort = cổng bên cạnh. Gateway poll D0..D39 và ghi lệnh FC06."),
        new("Mitsubishi MC 3E (server)", "mc", 5001, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = MitsubishiMc, PlcHost = IP máy này, McPlcType = Q hoặc iQ-R."),
        new("Omron FINS/UDP (server)", "fins-udp", 9600, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = OmronFins, FinsProtocol = udp, PlcHost = IP máy này (FinsDestNode = octet cuối IP)."),
        new("Omron FINS/TCP (server)", "fins-tcp", 9600, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = OmronFins, FinsProtocol = tcp, PlcHost = IP máy này."),
        new("Siemens S7 (ISO-on-TCP server)", "s7", 102, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = S7, PlcHost = IP máy này, S7Cpu = S71500 (hoặc S71200…), S7Db = DB bất kỳ (DBW(2n) = D n)."),
        new("EtherNet/IP Rockwell (server)", "eip", 44818, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = EtherNetIp, PlcHost = IP máy này, EipTag = tên tag bên dưới (INT[300]), EipSlot = 0."),
        new("OPC UA (server)", "opcua", 4840, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = OpcUa, OpcUaEndpoint = opc.tcp://<IP máy này>:<cổng>/plcsim, OpcUaImageNode = ns=2;s=PLC_D, OpcUaWriteNode = ns=2;s=PLC_W{a}."),
        new("Beckhoff ADS (AMS router + PLC)", "ads", 48898, "Địa chỉ nghe (bind)",
            "Gateway C#: Source = BeckhoffAds, AdsNetId = AmsNetId bên dưới, AdsPort = 851, AdsSymbol = symbol bên dưới. Máy gateway phải trỏ router ADS (cổng 48898) tới simulator."),
        new("MQTT → broker LAN của gateway", "mqtt", 1883, "Địa chỉ gateway (broker LAN)",
            "Gateway C#: Source = Gateway + LocalBrokerEnabled; thêm LocalUsers {User, Password, Role = Device}. Site/Device phải trùng cấu hình gateway. Gửi schema:2 + d tới webapp."),
    };

    static readonly (int A, string Name)[] RegNames =
    {
        (0, "Đầu vào X0..X7 (bitmask)"), (1, "Đầu ra Y0..Y7 (bitmask)"), (2, "Cảnh báo (bit0 E-stop, bit1 mức)"),
        (3, "Chế độ 0 tự động / 1 thủ công"), (4, "Mặt nạ đầu ra khi thủ công"), (5, "—"),
        (6, "Yêu cầu băng tải 0/1"), (7, "Số lượng mục tiêu (0 = không giới hạn)"), (8, "Trạng thái băng tải 0 dừng/1 chạy/2 đủ/3 E-stop"),
        (9, "Ghi 1 = xoá số đếm"), (10, "Thời gian chạy PLC (s) thấp"), (11, "Thời gian chạy PLC (s) cao"),
        (12, "Số lần khởi động bơm thấp"), (13, "Số lần khởi động bơm cao"), (14, "Số đếm hiện tại thấp"), (15, "Số đếm hiện tại cao"),
        (16, "Tổng số đếm thấp"), (17, "Tổng số đếm cao"),
    };

    readonly PlcModel _model = new();
    IEndpoint? _ep;
    int _protoIdx;

    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TextBox _host = new() { Text = "0.0.0.0" };
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Value = 502 };
    readonly TextBox _site = new() { Text = "factory1" };
    readonly TextBox _device = new() { Text = "plc01" };
    readonly TextBox _user = new() { Text = "gw" };
    readonly TextBox _pass = new() { UseSystemPasswordChar = true };
    readonly TextBox _tag = new() { Text = "PLC_D" };
    readonly Label _tagLbl = new() { Text = "Tag EIP / symbol ADS", AutoSize = true, Anchor = AnchorStyles.Left };
    readonly NumericUpDown _interval = new() { Minimum = 200, Maximum = 600000, Increment = 100, Value = 1000 };
    readonly CheckBox _auto = new() { Text = "Tự động gửi theo chu kỳ", Checked = true, AutoSize = true };
    readonly CheckBox _sim = new() { Text = "Mô phỏng băng tải (đếm khi chạy)", Checked = true, AutoSize = true };
    readonly Button _start = new() { Text = "▶ Bắt đầu", AutoSize = true };
    readonly Button _sendNow = new() { Text = "Gửi ngay", AutoSize = true, Enabled = false };
    readonly Label _hint = new() { AutoSize = true, MaximumSize = new Size(900, 0), ForeColor = Color.DimGray };
    readonly Label _status = new() { AutoSize = true, Text = "Đã dừng" };
    readonly Label _hostLbl = new() { Text = "Địa chỉ", AutoSize = true, Anchor = AnchorStyles.Left };
    readonly Label _userLbl = new() { Text = "MQTT user", AutoSize = true, Anchor = AnchorStyles.Left };
    readonly Label _passLbl = new() { Text = "MQTT password", AutoSize = true, Anchor = AnchorStyles.Left };

    readonly DataGridView _regs = new();
    readonly DataGridView _fields = new();
    readonly DataGridView _actions = new() { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, RowHeadersVisible = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, SelectionMode = DataGridViewSelectionMode.FullRowSelect };
    readonly NumericUpDown _wAddr = new() { Minimum = 0, Maximum = PlcModel.Size - 1 };
    readonly NumericUpDown _wVal = new() { Minimum = 0, Maximum = 65535 };
    readonly TextBox _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 9f) };

    readonly System.Windows.Forms.Timer _sendTimer = new();
    readonly System.Windows.Forms.Timer _uiTimer = new() { Interval = 300 };
    readonly System.Windows.Forms.Timer _simTimer = new() { Interval = 1000 };
    bool _busy, _refreshing;

    static string SettingsPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PlcSim", "settings.json");

    public MainForm()
    {
        Text = "PLC Simulator — giả lập PLC gửi tới gateway";
        Width = 1180; Height = 780; MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;

        foreach (var p in Protos) _proto.Items.Add(p.Label);
        BuildLayout();
        BuildRegGrid();
        BuildFieldGrid();
        LoadSettings();
        if (_proto.SelectedIndex < 0) _proto.SelectedIndex = 0;
        ApplyProtoDefaults(keepPort: true);

        _proto.SelectedIndexChanged += (_, _) => ApplyProtoDefaults(keepPort: false);
        _start.Click += async (_, _) => await ToggleAsync();
        _sendNow.Click += async (_, _) => await PushAsync(manual: true);
        _sendTimer.Tick += async (_, _) => { if (_auto.Checked && _protoKind == "mqtt") await PushAsync(manual: false); };
        _uiTimer.Tick += (_, _) => RefreshGrids();
        _simTimer.Tick += (_, _) => { if (_sim.Checked && _ep != null) _model.SimTick(); };
        _interval.ValueChanged += (_, _) => _sendTimer.Interval = (int)_interval.Value;
        _uiTimer.Start(); _simTimer.Start();
        FormClosing += async (_, _) => { SaveSettings(); await StopAsync(); };
        if (Environment.GetCommandLineArgs().Contains("--autostart")) Shown += async (_, _) => await ToggleAsync();
    }

    string _protoKind => Protos[Math.Max(0, _proto.SelectedIndex)].Kind;

    // ------------------------------------------------------------------ giao diện
    void BuildLayout()
    {
        var cfg = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 6, Padding = new Padding(8) };
        for (var i = 0; i < 6; i++) cfg.ColumnStyles.Add(new ColumnStyle(i % 2 == 0 ? SizeType.AutoSize : SizeType.Percent, i % 2 == 0 ? 0 : 33f));
        void Row(params Control[] cs) { foreach (var c in cs) { c.Dock = c is Label ? DockStyle.None : DockStyle.Fill; cfg.Controls.Add(c); } }
        Row(L("Giao thức"), _proto, _hostLbl, _host, L("Cổng"), _port);
        Row(L("Site"), _site, L("Device"), _device, L("Chu kỳ gửi (ms)"), _interval);
        Row(_userLbl, _user, _passLbl, _pass, _tagLbl, _tag);
        var opts = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        opts.Controls.AddRange(new Control[] { _start, _sendNow, _auto, _sim, _status });
        cfg.Controls.Add(opts); cfg.SetColumnSpan(opts, 6);
        cfg.Controls.Add(_hint); cfg.SetColumnSpan(_hint, 6);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        var tReg = new TabPage("Thanh ghi D (r)");
        var wr = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(4) };
        var wBtn = new Button { Text = "Ghi D", AutoSize = true };
        wBtn.Click += (_, _) => { _model.Set((int)_wAddr.Value, (ushort)_wVal.Value, "ui"); AppendLog($"UI: D{(int)_wAddr.Value} = {(int)_wVal.Value}"); };
        wr.Controls.AddRange(new Control[] { L("Địa chỉ D"), _wAddr, L("Giá trị"), _wVal, wBtn });
        tReg.Controls.Add(_regs); tReg.Controls.Add(wr);
        var tAct = new TabPage("Lệnh từ webapp / cloud");
        foreach (var h in new[] { "Thời gian", "Nguồn", "Thanh ghi", "Thiết bị con", "Giá trị" }) _actions.Columns.Add(h, h);
        tAct.Controls.Add(_actions);
        _model.Changed += OnModelChanged;
        var tFld = new TabPage("Thiết bị con (d.<childId>.<field>)");
        var fNote = new Label { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(4), ForeColor = Color.DimGray,
            Text = "childId/field phải trùng tem QR/pack của thiết bị trên server. MQTT gửi thẳng d.<child>.<field>. Giao thức khác: điền cột D + scale, gateway đọc D rồi đóng gói d = D / scale (cùng bảng Pack trong gateway). Thêm dòng ở hàng cuối." };
        tFld.Controls.Add(_fields); tFld.Controls.Add(fNote);
        tabs.TabPages.Add(tAct); tabs.TabPages.Add(tReg); tabs.TabPages.Add(tFld);

        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, SplitterDistance = 360 };
        split.Panel1.Controls.Add(tabs);
        var logBox = new GroupBox { Text = "Nhật ký (gửi / nhận lệnh điều khiển)", Dock = DockStyle.Fill };
        logBox.Controls.Add(_log);
        split.Panel2.Controls.Add(logBox);
        Controls.Add(split); Controls.Add(cfg);
    }

    static Label L(string t) => new() { Text = t, AutoSize = true, Anchor = AnchorStyles.Left };

    void BuildRegGrid()
    {
        _regs.Dock = DockStyle.Fill; _regs.AllowUserToAddRows = false; _regs.AllowUserToDeleteRows = false;
        _regs.RowHeadersVisible = false; _regs.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        _regs.Columns.Add("a", "D"); _regs.Columns.Add("n", "Ý nghĩa"); _regs.Columns.Add("v", "Giá trị (0–65535)");
        _regs.Columns[0].FillWeight = 10; _regs.Columns[1].FillWeight = 60; _regs.Columns[2].FillWeight = 30;
        _regs.Columns[0].ReadOnly = true; _regs.Columns[1].ReadOnly = true;
        var names = RegNames.ToDictionary(x => x.A, x => x.Name);
        for (var i = 0; i < PlcModel.TelemetryRegs; i++)
            _regs.Rows.Add(i, names.GetValueOrDefault(i, ""), _model.Get(i));
        _regs.CellEndEdit += (_, e) =>
        {
            if (e.ColumnIndex != 2 || _refreshing) return;
            var a = Convert.ToInt32(_regs[0, e.RowIndex].Value);
            if (ushort.TryParse(Convert.ToString(_regs[2, e.RowIndex].Value), out var v)) _model.Set(a, v, "ui");
            else _regs[2, e.RowIndex].Value = _model.Get(a);
        };
    }

    void BuildFieldGrid()
    {
        _fields.Dock = DockStyle.Fill; _fields.AllowUserToAddRows = true; _fields.AllowUserToDeleteRows = true;
        _fields.RowHeadersVisible = false; _fields.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        _fields.Columns.Add("c", "childId"); _fields.Columns.Add("f", "field"); _fields.Columns.Add("v", "Giá trị (số)");
        _fields.Columns.Add("d", "D (Modbus/MC/FINS/S7/…)"); _fields.Columns.Add("s", "scale (D = giá trị × scale)");
        if (_fields.Rows.Count <= 1 && _model.Fields().Length == 0)
        {
            foreach (var (c, f, v, d, sc) in new[] { ("env1", "t", 28.5, 50, 10), ("env1", "h", 62, 51, 10), ("pump1", "run", 0, 52, 1), ("pump1", "flow", 0, 53, 10) })
            {
                _fields.Rows.Add(c, f, v.ToString(CultureInfo.InvariantCulture), d, sc);
                _model.MapField(c, f, d, sc);
                _model.SetField(c, f, v, "ui");
            }
        }
        _fields.CellEndEdit += (_, e) => CommitFieldRow(e.RowIndex);
        _fields.UserDeletingRow += (_, e) =>
        {
            var r = e.Row;
            var c = Convert.ToString(r.Cells[0].Value)?.Trim(); var f = Convert.ToString(r.Cells[1].Value)?.Trim();
            if (!string.IsNullOrEmpty(c) && !string.IsNullOrEmpty(f)) _model.RemoveField(c, f);
        };
    }

    void CommitFieldRow(int row)
    {
        if (_refreshing || row < 0 || row >= _fields.Rows.Count || _fields.Rows[row].IsNewRow) return;
        var c = Convert.ToString(_fields[0, row].Value)?.Trim();
        var f = Convert.ToString(_fields[1, row].Value)?.Trim();
        var raw = Convert.ToString(_fields[2, row].Value)?.Trim().Replace(',', '.');
        if (string.IsNullOrEmpty(c) || string.IsNullOrEmpty(f)) return;
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) { _fields[2, row].Value = "0"; v = 0; }
        var dRaw = Convert.ToString(_fields[3, row].Value)?.Trim();
        var sRaw = Convert.ToString(_fields[4, row].Value)?.Trim().Replace(',', '.');
        if (int.TryParse(dRaw, out var da) && da is >= 0 and < PlcModel.Size)
        {
            var sc = double.TryParse(sRaw, NumberStyles.Float, CultureInfo.InvariantCulture, out var x) && x > 0 ? x : 1;
            _model.MapField(c, f, da, sc);
        }
        else _model.MapField(c, f, -1, 1);
        _model.SetField(c, f, v, "ui");
    }

    /// <summary>Cập nhật lưới theo model (giá trị do gateway ghi hoặc mô phỏng thay đổi) khi không đang sửa ô.</summary>
    void RefreshGrids()
    {
        _refreshing = true;
        try
        {
            if (!_regs.IsCurrentCellInEditMode)
                foreach (DataGridViewRow r in _regs.Rows)
                {
                    var v = _model.Get(Convert.ToInt32(r.Cells[0].Value));
                    if (!Equals(r.Cells[2].Value, (object)(int)v) && Convert.ToString(r.Cells[2].Value) != v.ToString()) r.Cells[2].Value = v.ToString();
                }
            if (!_fields.IsCurrentCellInEditMode)
            {
                foreach (var (c, f, v) in _model.Fields())
                {
                    var row = _fields.Rows.Cast<DataGridViewRow>().FirstOrDefault(r =>
                        !r.IsNewRow && Convert.ToString(r.Cells[0].Value)?.Trim() == c && Convert.ToString(r.Cells[1].Value)?.Trim() == f);
                    var s = v.ToString(CultureInfo.InvariantCulture);
                    if (row == null) _fields.Rows.Add(c, f, s, _model.MapOf(c, f)?.Addr.ToString() ?? "", _model.MapOf(c, f)?.Scale.ToString(CultureInfo.InvariantCulture) ?? "");
                    else if (Convert.ToString(row.Cells[2].Value) != s) row.Cells[2].Value = s;
                }
            }
        }
        finally { _refreshing = false; }
        _status.Text = _ep == null ? "Đã dừng" : $"● Đang chạy: {_ep.Name} — {(_protoKind == "mqtt" ? (_ep.Peers > 0 ? "đã nối gateway" : "chưa nối gateway") : $"{_ep.Peers} gateway đang kết nối")}";
        _status.ForeColor = _ep == null ? Color.Gray : _ep.Peers > 0 ? Color.ForestGreen : Color.DarkOrange;
    }

    // ------------------------------------------------------------------ điều khiển
    void ApplyProtoDefaults(bool keepPort)
    {
        _protoIdx = Math.Max(0, _proto.SelectedIndex);
        var p = Protos[_protoIdx];
        var mqtt = p.Kind == "mqtt";
        _hostLbl.Text = p.HostLabel;
        if (!keepPort)
        {
            _port.Value = p.Port;
            _host.Text = mqtt ? "127.0.0.1" : "0.0.0.0";
        }
        _user.Enabled = _pass.Enabled = mqtt;
        _userLbl.Enabled = _passLbl.Enabled = mqtt;
        if (p.Kind == "ads" && _tag.Text == "PLC_D") _tag.Text = "GVL_PLC.D";
        if (p.Kind == "eip" && _tag.Text == "GVL_PLC.D") _tag.Text = "PLC_D";
        _hint.Text = p.GatewayHint;
    }

    async Task ToggleAsync()
    {
        if (_ep != null) { await StopAsync(); return; }
        _commitAll();
        var p = Protos[_proto.SelectedIndex];
        void Log(string s) => AppendLog(s);
        try
        {
            var port = (int)_port.Value;
            _ep = p.Kind switch
            {
                "modbus" => new ModbusTcpSlave(_model, _host.Text.Trim(), port, Log),
                "mc" => new MitsubishiMcServer(_model, _host.Text.Trim(), port, Log),
                "fins-udp" => new OmronFinsServer(_model, _host.Text.Trim(), port, false, Log),
                "fins-tcp" => new OmronFinsServer(_model, _host.Text.Trim(), port, true, Log),
                "s7" => new S7Server(_model, _host.Text.Trim(), port, Log),
                "eip" => new EtherNetIpServer(_model, _host.Text.Trim(), port, _tag.Text, Log),
                "ads" => new BeckhoffAdsServer(_model, _host.Text.Trim(), port, _tag.Text, Log),
                "opcua" => new OpcUaPlcServer(_model, _host.Text.Trim(), port, Log),
                "mqtt" => new MqttGatewayLink(_model, _host.Text.Trim(), port, _user.Text.Trim(), _pass.Text, _site.Text.Trim(), _device.Text.Trim(), Log),
                _ => throw new InvalidOperationException(),
            };
            await _ep.StartAsync();
        }
        catch (Exception ex)
        {
            AppendLog($"Không khởi động được {p.Label}: {ex.Message}");
            if (_ep != null) { await _ep.DisposeAsync(); _ep = null; }
            return;
        }
        SetRunning(true);
        _sendTimer.Interval = (int)_interval.Value;
        _sendTimer.Start();
        if (p.Kind == "mqtt") await PushAsync(manual: false);
    }

    void _commitAll()
    {
        _regs.EndEdit(); _fields.EndEdit();
        for (var i = 0; i < _fields.Rows.Count; i++) CommitFieldRow(i);
    }

    async Task StopAsync()
    {
        _sendTimer.Stop();
        var ep = _ep; _ep = null;
        if (ep != null) { try { await ep.DisposeAsync(); } catch { /* ignore */ } AppendLog("Đã dừng."); }
        SetRunning(false);
    }

    void SetRunning(bool run)
    {
        _start.Text = run ? "■ Dừng" : "▶ Bắt đầu";
        _sendNow.Enabled = run;
        _proto.Enabled = _host.Enabled = _port.Enabled = _site.Enabled = _device.Enabled = !run;
        var mqtt = _protoKind == "mqtt";
        _user.Enabled = _pass.Enabled = !run && mqtt;
    }

    async Task PushAsync(bool manual)
    {
        if (_ep == null || _busy) return;
        _busy = true;
        try { _commitAll(); await _ep.PushAsync(); }
        catch (Exception ex) { AppendLog($"Gửi lỗi: {ex.Message}"); }
        finally { _busy = false; }
    }

    // Mọi ghi từ gateway (gốc là webapp/cloud hoặc HMI) hiện thành một dòng trong tab "Lệnh từ webapp / cloud".
    void OnModelChanged(string desc, string origin)
    {
        if (origin != "gateway") return;
        if (InvokeRequired) { try { BeginInvoke(() => OnModelChanged(desc, origin)); } catch { } return; }
        string reg = "", child = "", val = desc;
        var m = System.Text.RegularExpressions.Regex.Match(desc, @"^D(\d+) = (-?\d+)$");
        if (m.Success) { var a = int.Parse(m.Groups[1].Value); reg = "D" + a; child = _model.FieldAt(a) ?? ""; val = m.Groups[2].Value; }
        else { var f = System.Text.RegularExpressions.Regex.Match(desc, @"^(d\.\S+) = (.+)$"); if (f.Success) { child = f.Groups[1].Value; val = f.Groups[2].Value; } }
        _actions.Rows.Insert(0, DateTime.Now.ToString("HH:mm:ss.fff"), "Modbus/MQTT master (gateway ← cloud)", reg, child, val);
        while (_actions.Rows.Count > 500) _actions.Rows.RemoveAt(_actions.Rows.Count - 1);
    }

    void AppendLog(string s)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { try { BeginInvoke(() => AppendLog(s)); } catch { /* đang đóng */ } return; }
        _log.AppendText($"{DateTime.Now:HH:mm:ss}  {s}{Environment.NewLine}");
        if (_log.TextLength > 60000) _log.Text = _log.Text[^40000..];
    }

    // ------------------------------------------------------------------ lưu cấu hình (không lưu password)
    sealed class Saved
    {
        public int Proto { get; set; } = -1;
        public string Host { get; set; } = "";
        public int Port { get; set; }
        public string Site { get; set; } = "factory1";
        public string Device { get; set; } = "plc01";
        public string User { get; set; } = "gw";
        public int Interval { get; set; } = 1000;
        public List<string[]> Fields { get; set; } = new();
    }

    void SaveSettings()
    {
        try
        {
            var s = new Saved
            {
                Proto = _proto.SelectedIndex, Host = _host.Text, Port = (int)_port.Value, Site = _site.Text, Device = _device.Text,
                User = _user.Text, Interval = (int)_interval.Value,
                Fields = _model.Fields().Select(f => new[] { f.Child, f.Field, f.Value.ToString(CultureInfo.InvariantCulture),
                    _model.MapOf(f.Child, f.Field)?.Addr.ToString() ?? "", _model.MapOf(f.Child, f.Field)?.Scale.ToString(CultureInfo.InvariantCulture) ?? "" }).ToList(),
            };
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* không quan trọng */ }
    }

    void LoadSettings()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return;
            var s = JsonSerializer.Deserialize<Saved>(File.ReadAllText(SettingsPath));
            if (s == null) return;
            if (s.Proto >= 0 && s.Proto < Protos.Length) _proto.SelectedIndex = s.Proto;
            if (s.Host.Length > 0) _host.Text = s.Host;
            if (s.Port is >= 1 and <= 65535) _port.Value = s.Port;
            _site.Text = s.Site; _device.Text = s.Device; _user.Text = s.User;
            if (s.Interval is >= 200 and <= 600000) _interval.Value = s.Interval;
            if (s.Fields.Count > 0)
            {
                _model.ClearChildren();
                _fields.Rows.Clear();
                foreach (var f in s.Fields.Where(f => f.Length >= 3))
                    if (double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
                    {
                        var da = f.Length >= 5 && int.TryParse(f[3], out var a0) ? a0 : -1;
                        var sc = f.Length >= 5 && double.TryParse(f[4], NumberStyles.Float, CultureInfo.InvariantCulture, out var s0) ? s0 : 1;
                        _model.MapField(f[0], f[1], da, sc);
                        _model.SetField(f[0], f[1], v, "ui");
                        _fields.Rows.Add(f[0], f[1], f[2], da >= 0 ? da.ToString() : "", da >= 0 ? sc.ToString(CultureInfo.InvariantCulture) : "");
                    }
            }
        }
        catch { /* file hỏng: dùng mặc định */ }
    }
}
