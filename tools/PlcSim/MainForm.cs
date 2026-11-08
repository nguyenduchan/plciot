using System.Globalization;
using System.Text.Json;
using PlcSim.Protocols;

namespace PlcSim;

/// <summary>
/// PLC giả lập (giao thức qua Ethernet). Mặc định RỖNG: bấm "＋ Thêm luồng dữ liệu" để tạo từng luồng
/// (thiết bị.field ↔ thanh ghi D, cách sinh giá trị), bấm "⚙ Giao thức…" để chọn giao thức và thông số kết nối.
/// </summary>
public sealed partial class MainForm : Form
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
        (3, "Chế độ 0 tự động / 1 thủ công"), (4, "Mặt nạ đầu ra khi thủ công"), (6, "Yêu cầu băng tải 0/1"),
        (7, "Số lượng mục tiêu (0 = không giới hạn)"), (8, "Trạng thái băng tải 0 dừng/1 chạy/2 đủ/3 E-stop"), (9, "Ghi 1 = xoá số đếm"),
    };

    readonly PlcModel _model = new();
    IEndpoint? _ep;

    // Trạng thái cấu hình giao thức (hộp thoại "Giao thức…" đọc/ghi các ô này; không hiện trực tiếp trên form chính)
    readonly ComboBox _proto = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly TextBox _host = new() { Text = "0.0.0.0" };
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Value = 502 };
    readonly TextBox _site = new() { Text = "factory1" };
    readonly TextBox _device = new() { Text = "plc01" };
    readonly TextBox _user = new() { Text = "gw" };
    readonly TextBox _pass = new() { UseSystemPasswordChar = true };
    readonly TextBox _tag = new() { Text = "PLC_D" };
    readonly NumericUpDown _interval = new() { Minimum = 200, Maximum = 600000, Increment = 100, Value = 1000 };

    readonly Button _start = new() { Text = "▶ Bắt đầu", AutoSize = true, Height = 32 };
    readonly Button _sendNow = new() { Text = "Gửi ngay", AutoSize = true, Height = 32, Enabled = false };
    readonly Button _protoBtn = new() { Text = "⚙ Giao thức…", AutoSize = true, Height = 32 };
    readonly CheckBox _sim = new() { Text = "Chạy mô phỏng giá trị", Checked = true, AutoSize = true, Margin = new Padding(14, 8, 0, 0) };
    readonly Label _status = new() { AutoSize = true, Text = "Đã dừng", Margin = new Padding(10, 8, 0, 0) };
    readonly Label _summary = new() { AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(14, 8, 0, 0) };
    readonly Label _empty = new() { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.DimGray, Font = new Font("Segoe UI", 11f),
        Text = "Chưa có luồng dữ liệu nào.\r\nBấm  ＋ Thêm luồng dữ liệu  để tạo (ví dụ mực nước, tốc độ bơm, nhiệt độ…)." };

    readonly DataGridView _streams = new();
    readonly DataGridView _regs = new();
    readonly DataGridView _actions = new() { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, RowHeadersVisible = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, SelectionMode = DataGridViewSelectionMode.FullRowSelect };
    readonly TextBox _log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = new Font("Consolas", 9f) };

    readonly System.Windows.Forms.Timer _sendTimer = new();
    readonly System.Windows.Forms.Timer _uiTimer = new() { Interval = 300 };
    readonly System.Windows.Forms.Timer _simTimer = new() { Interval = 1000 };
    bool _busy, _refreshing;
    string _sig = "";

    static string SettingsPath => Environment.GetEnvironmentVariable("PLCSIM_SETTINGS") is { Length: > 0 } p ? p
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PlcSim", "settings.json");
    string _protoKind => Protos[Math.Max(0, _proto.SelectedIndex)].Kind;

    public MainForm()
    {
        Text = "PLC Simulator — giả lập PLC qua Ethernet";
        Width = 1100; Height = 720; MinimumSize = new Size(860, 560);
        StartPosition = FormStartPosition.CenterScreen;

        foreach (var p in Protos) _proto.Items.Add(p.Label);
        BuildLayout();
        BuildRegGrid();
        LoadSettings();
        if (_proto.SelectedIndex < 0) _proto.SelectedIndex = 0;
        ApplyProtoDefaults(keepPort: true);
        RefreshStreams();

        _start.Click += async (_, _) => await ToggleAsync();
        _sendNow.Click += async (_, _) => await PushAsync();
        _protoBtn.Click += (_, _) => EditProtocol();
        _sendTimer.Tick += async (_, _) => { if (_protoKind == "mqtt") await PushAsync(); };
        _uiTimer.Tick += (_, _) => RefreshGrids();
        _simTimer.Tick += (_, _) => { if (_sim.Checked && _ep != null) _model.SimTick(); };
        _uiTimer.Start(); _simTimer.Start();
        _model.Changed += OnModelChanged;
        FormClosing += async (_, _) => { SaveSettings(); await StopAsync(); };
        if (Environment.GetCommandLineArgs().Contains("--autostart")) Shown += async (_, _) => await ToggleAsync();
    }

    // ------------------------------------------------------------------ giao diện
    void BuildLayout()
    {
        var top = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8, 8, 8, 4) };
        top.Controls.AddRange(new Control[] { _start, _sendNow, _protoBtn, _sim, _status, _summary });

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8, 0, 8, 6) };
        var add = new Button { Text = "＋ Thêm luồng dữ liệu", AutoSize = true, Height = 32, BackColor = Color.FromArgb(50, 116, 217), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        var edit = new Button { Text = "Sửa", AutoSize = true, Height = 32 };
        var del = new Button { Text = "Xoá", AutoSize = true, Height = 32 };
        var sample = new Button { Text = "Nạp mẫu bồn nước + bơm", AutoSize = true, Height = 32 };
        add.Click += (_, _) => AddOrEditStream(null);
        edit.Click += (_, _) => AddOrEditStream(SelectedStream());
        del.Click += (_, _) => DeleteStream();
        sample.Click += (_, _) => LoadSample();
        bar.Controls.AddRange(new Control[] { add, edit, del, sample });

        _streams.Dock = DockStyle.Fill; _streams.AllowUserToAddRows = false; _streams.ReadOnly = true; _streams.RowHeadersVisible = false;
        _streams.SelectionMode = DataGridViewSelectionMode.FullRowSelect; _streams.MultiSelect = false;
        _streams.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        foreach (var (h, w) in new[] { ("Thiết bị", 14f), ("Field", 12f), ("D", 7f), ("Hệ số", 7f), ("Cách sinh giá trị", 18f), ("Cài đặt", 26f), ("Hiện tại", 12f) })
            _streams.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = h, FillWeight = w });
        _streams.CellDoubleClick += (_, e) => { if (e.RowIndex >= 0) AddOrEditStream(SelectedStream()); };
        _streams.KeyDown += (_, e) => { if (e.KeyCode == Keys.Delete) { e.Handled = true; DeleteStream(); } };
        var tStreams = new TabPage("Luồng dữ liệu");
        tStreams.Controls.Add(_streams); tStreams.Controls.Add(_empty); _empty.BringToFront();

        var tAct = new TabPage("Lệnh nhận từ gateway / webapp");
        foreach (var h in new[] { "Thời gian", "Nguồn", "Thanh ghi", "Thiết bị con", "Giá trị" }) _actions.Columns.Add(h, h);
        tAct.Controls.Add(_actions);

        var tReg = new TabPage("Thanh ghi D");
        var wr = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, Padding = new Padding(4) };
        var wAddr = new NumericUpDown { Minimum = 0, Maximum = PlcModel.Size - 1 };
        var wVal = new NumericUpDown { Minimum = 0, Maximum = 65535 };
        var wBtn = new Button { Text = "Ghi D", AutoSize = true };
        wBtn.Click += (_, _) => { _model.Set((int)wAddr.Value, (ushort)wVal.Value, "ui"); AppendLog($"UI: D{(int)wAddr.Value} = {(int)wVal.Value}"); };
        wr.Controls.AddRange(new Control[] { new Label { Text = "Địa chỉ D", AutoSize = true, Margin = new Padding(0, 6, 0, 0) }, wAddr, new Label { Text = "Giá trị", AutoSize = true, Margin = new Padding(8, 6, 0, 0) }, wVal, wBtn });
        tReg.Controls.Add(_regs); tReg.Controls.Add(wr);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(tStreams); tabs.TabPages.Add(tAct); tabs.TabPages.Add(tReg);

        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, SplitterDistance = 400 };
        split.Panel1.Controls.Add(tabs);
        var logBox = new GroupBox { Text = "Nhật ký", Dock = DockStyle.Fill };
        logBox.Controls.Add(_log);
        split.Panel2.Controls.Add(logBox);
        Controls.Add(split); Controls.Add(bar); Controls.Add(top);
    }

    void BuildRegGrid()
    {
        _regs.Dock = DockStyle.Fill; _regs.AllowUserToAddRows = false; _regs.AllowUserToDeleteRows = false;
        _regs.RowHeadersVisible = false; _regs.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        _regs.Columns.Add("a", "D"); _regs.Columns.Add("n", "Ý nghĩa"); _regs.Columns.Add("v", "Giá trị (0–65535)");
        _regs.Columns[0].FillWeight = 10; _regs.Columns[1].FillWeight = 60; _regs.Columns[2].FillWeight = 30;
        _regs.Columns[0].ReadOnly = true; _regs.Columns[1].ReadOnly = true;
        var names = RegNames.ToDictionary(x => x.A, x => x.Name);
        for (var i = 0; i < PlcModel.TelemetryRegs; i++) _regs.Rows.Add(i, names.GetValueOrDefault(i, ""), _model.Get(i));
        _regs.CellEndEdit += (_, e) =>
        {
            if (e.ColumnIndex != 2 || _refreshing) return;
            var a = Convert.ToInt32(_regs[0, e.RowIndex].Value);
            if (ushort.TryParse(Convert.ToString(_regs[2, e.RowIndex].Value), out var v)) _model.Set(a, v, "ui");
            else _regs[2, e.RowIndex].Value = _model.Get(a);
        };
    }

    // ------------------------------------------------------------------ luồng dữ liệu
    sealed record Stream(string Child, string Field, int Addr, double Scale);

    IEnumerable<Stream> Streams() => _model.Fields().Select(f =>
    {
        var m = _model.MapOf(f.Child, f.Field);
        return new Stream(f.Child, f.Field, m?.Addr ?? -1, m?.Scale ?? 1);
    });

    Stream? SelectedStream()
    {
        if (_streams.CurrentRow == null) return null;
        var c = Convert.ToString(_streams.CurrentRow.Cells[0].Value); var f = Convert.ToString(_streams.CurrentRow.Cells[1].Value);
        return Streams().FirstOrDefault(s => s.Child == c && s.Field == f);
    }

    static string GenText(PlcModel.Gen g, double value) => g.Mode switch
    {
        PlcModel.FieldMode.Fixed => $"= {value.ToString("0.###", CultureInfo.InvariantCulture)}",
        PlcModel.FieldMode.Random => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)} mỗi giây",
        PlcModel.FieldMode.Sine => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)}, chu kỳ {g.Period.ToString("0.#", CultureInfo.InvariantCulture)} s",
        PlcModel.FieldMode.Ramp => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)}, bước {g.Step.ToString("0.###", CultureInfo.InvariantCulture)}/s",
        _ => "bồn nước tự chạy theo tốc độ bơm",
    };

    static readonly string[] ModeNames = { "Cố định", "Ngẫu nhiên trong khoảng", "Mô phỏng bồn nước", "Sóng sin", "Tăng dần" };
    static string ModeName(PlcModel.FieldMode m) => ModeNames[m switch { PlcModel.FieldMode.Fixed => 0, PlcModel.FieldMode.Random => 1, PlcModel.FieldMode.Sim => 2, PlcModel.FieldMode.Sine => 3, _ => 4 }];

    string Sig() => string.Join("|", Streams().Select(s => $"{s.Child}.{s.Field}@{s.Addr}x{s.Scale}:{_model.ModeOf(s.Child, s.Field)}"));

    void RefreshStreams()
    {
        _sig = Sig();
        var keep = _streams.CurrentRow?.Index ?? -1;
        _streams.Rows.Clear();
        var vals = _model.Fields().ToDictionary(f => (f.Child, f.Field), f => f.Value);
        foreach (var s in Streams())
        {
            var g = _model.ModeOf(s.Child, s.Field);
            _streams.Rows.Add(s.Child, s.Field, s.Addr >= 0 ? "D" + s.Addr : "—", s.Addr >= 0 ? s.Scale.ToString(CultureInfo.InvariantCulture) : "—", ModeName(g.Mode), GenText(g, vals[(s.Child, s.Field)]), "");
        }
        _empty.Visible = _streams.Rows.Count == 0;
        if (keep >= 0 && keep < _streams.Rows.Count) _streams.CurrentCell = _streams.Rows[keep].Cells[0];
    }

    void AddOrEditStream(Stream? edit)
    {
        using var d = NewStreamDialog(edit);
        if (d.ShowDialog(this) != DialogResult.OK) return;
        ApplyStream(d);
    }

    StreamDialog NewStreamDialog(Stream? edit)
    {
        var used = Streams().Where(s => edit == null || !(s.Child == edit.Child && s.Field == edit.Field)).Select(s => s.Addr).Where(a => a >= 0).ToHashSet();
        var children = Streams().Select(s => s.Child).Distinct().ToArray();
        var cur = edit == null ? 0 : _model.Fields().First(f => f.Child == edit.Child && f.Field == edit.Field).Value;
        return new StreamDialog(edit?.Child, edit?.Field, edit?.Addr ?? -1, edit?.Scale ?? 10, edit == null ? new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100) : _model.ModeOf(edit.Child, edit.Field), cur, used, children, Streams().Select(s => (s.Child, s.Field)).ToHashSet(), edit != null);
    }

    void ApplyStream(StreamDialog d)
    {
        _model.MapField(d.Child, d.Field, d.Addr, d.Scale);
        _model.SetMode(d.Child, d.Field, d.Gen);
        _model.SetField(d.Child, d.Field, d.Value, "ui");
        AppendLog($"UI: luồng {d.Child}.{d.Field} → D{d.Addr}, {ModeName(d.Gen.Mode)}");
        RefreshStreams();
    }

    void DeleteStream()
    {
        var s = SelectedStream();
        if (s == null) { AppendLog("Chọn một dòng luồng dữ liệu cần xoá."); return; }
        if (!Ask.Yes(this, $"Xoá luồng {s.Child}.{s.Field} (D{s.Addr})?"+"\n\n"+"Gateway đang đọc luồng này sẽ nhận 0.", "Xác nhận xoá luồng dữ liệu")) return;
        _model.RemoveField(s.Child, s.Field);
        AppendLog($"UI: đã xoá luồng {s.Child}.{s.Field}");
        RefreshStreams();
    }

    void LoadSample()
    {
        if (_model.Fields().Length > 0 && MessageBox.Show(this, "Thay toàn bộ luồng hiện có bằng bộ mẫu bồn nước + bơm + nhiệt độ?", "Nạp mẫu", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
        _model.ClearChildren();
        foreach (var (c, f, v, a, sc, g) in new (string, string, double, int, double, PlcModel.Gen)[]
        {
            ("tank1", "level", 50, 50, 10, new(PlcModel.FieldMode.Sim, 0, 100)),
            ("pump1", "run", 1, 51, 1, new(PlcModel.FieldMode.Fixed, 0, 1)),
            ("pump1", "speed", 30, 52, 10, new(PlcModel.FieldMode.Fixed, 0, 100)),
            ("pump1", "hours", 0, 53, 10, new(PlcModel.FieldMode.Sim, 0, 100)),
            ("pump1", "flow", 0, 54, 10, new(PlcModel.FieldMode.Sim, 0, 100)),
            ("env1", "t", 27, 55, 10, new(PlcModel.FieldMode.Sine, 22, 32, 90)),
            ("env1", "h", 60, 56, 10, new(PlcModel.FieldMode.Random, 50, 70)),
        })
        {
            _model.MapField(c, f, a, sc); _model.SetMode(c, f, g); _model.SetField(c, f, v, "ui");
        }
        RefreshStreams();
    }

    // ------------------------------------------------------------------ giao thức
    void ApplyProtoDefaults(bool keepPort)
    {
        var p = Protos[Math.Max(0, _proto.SelectedIndex)];
        if (!keepPort) { _port.Value = p.Port; _host.Text = p.Kind == "mqtt" ? "127.0.0.1" : "0.0.0.0"; }
        if (p.Kind == "ads" && _tag.Text == "PLC_D") _tag.Text = "GVL_PLC.D";
        if (p.Kind == "eip" && _tag.Text == "GVL_PLC.D") _tag.Text = "PLC_D";
        UpdateSummary();
    }

    void UpdateSummary()
    {
        var p = Protos[Math.Max(0, _proto.SelectedIndex)];
        _summary.Text = $"{p.Label} · {_host.Text.Trim()}:{(int)_port.Value}";
    }

    void EditProtocol()
    {
        if (_ep != null) { MessageBox.Show(this, "Dừng PLC trước khi đổi giao thức.", "Giao thức"); return; }
        using var d = new ProtocolDialog(Protos.Select(p => (p.Label, p.Kind, p.Port, p.HostLabel, p.GatewayHint)).ToArray(), _proto.SelectedIndex, _host.Text, (int)_port.Value,
            _site.Text, _device.Text, _user.Text, _pass.Text, _tag.Text, (int)_interval.Value);
        if (d.ShowDialog(this) != DialogResult.OK) return;
        _proto.SelectedIndex = d.ProtoIndex; _host.Text = d.Host; _port.Value = d.Port; _site.Text = d.Site; _device.Text = d.Device;
        _user.Text = d.User; _pass.Text = d.Pass; _tag.Text = d.Tag; _interval.Value = d.IntervalMs;
        UpdateSummary();
    }

    // ------------------------------------------------------------------ cập nhật lưới
    void RefreshGrids()
    {
        _refreshing = true;
        try
        {
            if (Sig() != _sig) RefreshStreams();
            var vals = _model.Fields().ToDictionary(f => (f.Child, f.Field), f => f.Value);
            foreach (DataGridViewRow r in _streams.Rows)
            {
                var k = (Convert.ToString(r.Cells[0].Value) ?? "", Convert.ToString(r.Cells[1].Value) ?? "");
                if (!vals.TryGetValue(k, out var v)) continue;
                r.Cells[6].Value = v.ToString("0.###", CultureInfo.InvariantCulture);
                var g = _model.ModeOf(k.Item1, k.Item2);
                if (g.Mode == PlcModel.FieldMode.Fixed) r.Cells[5].Value = GenText(g, v);
            }
            if (!_regs.IsCurrentCellInEditMode)
                foreach (DataGridViewRow r in _regs.Rows)
                {
                    var v = _model.Get(Convert.ToInt32(r.Cells[0].Value));
                    if (Convert.ToString(r.Cells[2].Value) != v.ToString()) r.Cells[2].Value = v.ToString();
                }
        }
        finally { _refreshing = false; }
        _status.Text = _ep == null ? "Đã dừng" : $"● Đang chạy: {_ep.Name} — {(_protoKind == "mqtt" ? (_ep.Peers > 0 ? "đã nối gateway" : "chưa nối gateway") : $"{_ep.Peers} gateway đang kết nối")}";
        _status.ForeColor = _ep == null ? Color.Gray : _ep.Peers > 0 ? Color.ForestGreen : Color.DarkOrange;
    }

    // ------------------------------------------------------------------ chạy / dừng
    async Task ToggleAsync()
    {
        if (_ep != null) { await StopAsync(); return; }
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
        if (p.Kind == "mqtt") await PushAsync();
    }

    async Task StopAsync()
    {
        _sendTimer.Stop();
        var ep = _ep; _ep = null;
        if (ep != null) { try { await ep.DisposeAsync(); } catch (Exception) { /* bỏ qua */ } AppendLog("Đã dừng."); }
        SetRunning(false);
    }

    void SetRunning(bool run)
    {
        _start.Text = run ? "■ Dừng" : "▶ Bắt đầu";
        _sendNow.Enabled = run;
        _protoBtn.Enabled = !run;
    }

    async Task PushAsync()
    {
        if (_ep == null || _busy) return;
        _busy = true;
        try { await _ep.PushAsync(); }
        catch (Exception ex) { AppendLog($"Gửi lỗi: {ex.Message}"); }
        finally { _busy = false; }
    }

    // Mọi ghi từ gateway (gốc là webapp/cloud hoặc HMI) hiện thành một dòng trong tab "Lệnh nhận từ gateway".
    void OnModelChanged(string desc, string origin)
    {
        if (origin != "gateway") return;
        if (InvokeRequired) { try { BeginInvoke(() => OnModelChanged(desc, origin)); } catch (InvalidOperationException) { } return; }
        string reg = "", child = "", val = desc;
        var m = System.Text.RegularExpressions.Regex.Match(desc, @"^D(\d+) = (-?\d+)$");
        if (m.Success) { var a = int.Parse(m.Groups[1].Value); reg = "D" + a; child = _model.FieldAt(a) ?? ""; val = m.Groups[2].Value; }
        else { var f = System.Text.RegularExpressions.Regex.Match(desc, @"^(d\.\S+) = (.+)$"); if (f.Success) { child = f.Groups[1].Value; val = f.Groups[2].Value; } }
        _actions.Rows.Insert(0, DateTime.Now.ToString("HH:mm:ss.fff"), "gateway ← cloud/webapp", reg, child, val);
        while (_actions.Rows.Count > 500) _actions.Rows.RemoveAt(_actions.Rows.Count - 1);
    }

    void AppendLog(string s)
    {
        if (InvokeRequired) { try { BeginInvoke(() => AppendLog(s)); } catch (InvalidOperationException) { } return; }
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
        public string Tag { get; set; } = "";
        /// <summary>Mỗi dòng: child, field, giá trị, D, hệ số, chế độ (tên enum), min, max, chu kỳ, bước.</summary>
        public List<string[]> Fields { get; set; } = new();
    }

    void SaveSettings()
    {
        try
        {
            var s = new Saved
            {
                Proto = _proto.SelectedIndex, Host = _host.Text, Port = (int)_port.Value, Site = _site.Text, Device = _device.Text,
                User = _user.Text, Interval = (int)_interval.Value, Tag = _tag.Text,
                Fields = _model.Fields().Select(f =>
                {
                    var m = _model.MapOf(f.Child, f.Field); var g = _model.ModeOf(f.Child, f.Field);
                    string N(double d) => d.ToString(CultureInfo.InvariantCulture);
                    return new[] { f.Child, f.Field, N(f.Value), m?.Addr.ToString() ?? "", m == null ? "" : N(m.Value.Scale), g.Mode.ToString(), N(g.Min), N(g.Max), N(g.Period), N(g.Step) };
                }).ToList(),
            };
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (IOException) { /* không quan trọng */ }
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
            if (s.Tag.Length > 0) _tag.Text = s.Tag;
            if (s.Interval is >= 200 and <= 600000) _interval.Value = s.Interval;
            double D(string[] r, int i, double dflt) => r.Length > i && double.TryParse(r[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var x) ? x : dflt;
            foreach (var f in s.Fields.Where(f => f.Length >= 3))
            {
                if (!double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) continue;
                var da = f.Length >= 5 && int.TryParse(f[3], out var a0) ? a0 : -1;
                var sc = D(f, 4, 1);
                _model.MapField(f[0], f[1], da, sc);
                // file cũ (5 cột) không có chế độ: mặc định cố định; chế độ đặt sau khi đã có đủ field nên level/flow vẫn suy ra Sim
                if (f.Length >= 8 && Enum.TryParse<PlcModel.FieldMode>(f[5], out var mode))
                    _model.SetMode(f[0], f[1], new PlcModel.Gen(mode, D(f, 6, 0), D(f, 7, 100), D(f, 8, 60), D(f, 9, 1)));
                _model.SetField(f[0], f[1], v, "ui");
            }
        }
        catch (Exception e) when (e is IOException or JsonException) { /* file hỏng: dùng mặc định rỗng */ }
    }
}
