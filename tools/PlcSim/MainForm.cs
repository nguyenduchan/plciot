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

    static readonly (int A, string Name)[] RegNames = Array.Empty<(int, string)>();

    readonly PlcModel _model = new();
    // Mỗi giao thức đang có luồng dữ liệu được bật một máy chủ riêng khi bấm "Bắt đầu".
    readonly List<(string Kind, IEndpoint Ep)> _eps = new();
    readonly Dictionary<string, ProtoCfg> _cfg = new();
    int _protoSel;   // giao thức đang chọn trong hộp thoại "Giao thức…"

    ProtoCfg Cfg(string kind)
    {
        if (_cfg.TryGetValue(kind, out var c)) return c;
        var p = Protos.First(x => x.Kind == kind);
        return _cfg[kind] = new ProtoCfg { Port = p.Port, Host = kind == "mqtt" ? "127.0.0.1" : "0.0.0.0", Tag = kind == "ads" ? "GVL_PLC.D" : kind == "eip" ? "PLC_D" : "" };
    }

    static string Short(ProtoInfo p) => p.Label.Split(" (")[0].Split(" →")[0];
    static string ShortOf(string kind) => Short(Protos.First(x => x.Kind == kind));

    readonly Button _start = new() { Text = "▶ Bắt đầu", AutoSize = true, Height = 32 };
    readonly Button _sendNow = new() { Text = "Gửi ngay", AutoSize = true, Height = 32, Enabled = false };
    readonly Button _protoBtn = new() { Text = "⚙ Kết nối…", AutoSize = true, Height = 32 };
    readonly CheckBox _sim = new() { Text = "Chạy mô phỏng giá trị", Checked = true, AutoSize = true, Margin = new Padding(14, 8, 0, 0) };
    readonly Label _status = new() { AutoSize = true, Text = "Đã dừng", Margin = new Padding(10, 8, 0, 0) };
    readonly Label _summary = new() { AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(14, 8, 0, 0) };
    readonly Label _empty = new() { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.DimGray, Font = new Font("Segoe UI", 11f),
        Text = "Chưa có luồng dữ liệu nào.\r\nBấm  ＋ Thêm luồng dữ liệu  để tạo." };

    readonly TabControl _tabs = new();
    Button _addBtn = null!;
    Action<StreamDialog>? _demoHook;
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

    public MainForm()
    {
        Text = "PLC Simulator — giả lập PLC qua Ethernet";
        Width = 1100; Height = 720; MinimumSize = new Size(860, 560);
        StartPosition = FormStartPosition.CenterScreen;

        BuildLayout();
        BuildRegGrid();
        LoadSettings();
        UpdateSummary();
        RefreshStreams();

        _start.Click += async (_, _) => await ToggleAsync();
        _sendNow.Click += async (_, _) => await PushAsync();
        _protoBtn.Click += (_, _) => EditProtocol();
        _sendTimer.Tick += async (_, _) => { if (_eps.Any(e => e.Kind == "mqtt")) await PushAsync(); };
        _uiTimer.Tick += (_, _) => RefreshGrids();
        _simTimer.Tick += (_, _) => { if (_sim.Checked && _eps.Count > 0) _model.SimTick(); };
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
        var add = _addBtn = new Button { Text = "＋ Thêm luồng dữ liệu", AutoSize = true, Height = 32, BackColor = Color.FromArgb(50, 116, 217), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        var edit = new Button { Text = "Sửa", AutoSize = true, Height = 32 };
        var del = new Button { Text = "Xoá", AutoSize = true, Height = 32 };
        add.Click += (_, _) => AddOrEditStream(null);
        edit.Click += (_, _) => AddOrEditStream(SelectedStream());
        del.Click += (_, _) => DeleteStream();
        bar.Controls.AddRange(new Control[] { add, edit, del });

        _streams.Dock = DockStyle.Fill; _streams.AllowUserToAddRows = false; _streams.ReadOnly = true; _streams.RowHeadersVisible = false;
        _streams.SelectionMode = DataGridViewSelectionMode.FullRowSelect; _streams.MultiSelect = false;
        _streams.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        foreach (var (h, w) in new[] { ("Thiết bị", 8f), ("Struct", 7f), ("Field", 8f), ("Kiểu", 6f), ("Giao thức", 9f), ("Quyền", 7f), ("D", 7f), ("Địa chỉ gateway", 14f), ("Hệ số", 5f), ("Cách sinh giá trị", 10f), ("Cài đặt", 15f), ("Hiện tại", 8f) })
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

        var tabs = _tabs; tabs.Dock = DockStyle.Fill;
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
    sealed record Stream(string Child, string Field, int Addr, double Scale, string Kind, PlcModel.Access Access, string Param, PlcModel.DataType Type, bool Swap, string Group);

    IEnumerable<Stream> Streams() => _model.Fields().Select(f =>
    {
        var m = _model.MapOf(f.Child, f.Field);
        var mt = _model.MetaOf(f.Child, f.Field);
        return new Stream(f.Child, f.Field, m?.Addr ?? -1, m?.Scale ?? 1, mt?.Kind ?? "modbus", mt?.Access ?? PlcModel.Access.ReadWrite, mt?.Param ?? "",
            mt is { Kind: not null } m2 ? m2.Type : PlcModel.DataType.UInt16, mt?.WordSwap ?? false, mt?.Group ?? "");
    });

    static readonly string[] TypeNames = { "UINT", "INT", "BOOL", "UDINT", "DINT", "REAL", "LREAL" };
    static string TypeName(PlcModel.DataType t) => TypeNames[(int)t switch { 0 => 0, 1 => 1, 2 => 2, 3 => 3, 4 => 4, 5 => 5, _ => 6 }];
    static string DRange(int addr, PlcModel.DataType t) => addr < 0 ? "—" : PlcModel.Words(t) == 1 ? "D" + addr : $"D{addr}–{addr + PlcModel.Words(t) - 1}";

    static string AccessName(PlcModel.Access a) => a switch { PlcModel.Access.Read => "Chỉ đọc", PlcModel.Access.Write => "Chỉ ghi", _ => "Đọc/ghi" };

    Stream? SelectedStream()
    {
        if (_streams.CurrentRow == null) return null;
        var c = Convert.ToString(_streams.CurrentRow.Cells[0].Value); var f = Convert.ToString(_streams.CurrentRow.Cells[2].Value);
        return Streams().FirstOrDefault(s => s.Child == c && s.Field == f);
    }

    static string GenText(PlcModel.Gen g, double value) => g.Mode switch
    {
        PlcModel.FieldMode.Fixed => $"= {value.ToString("0.###", CultureInfo.InvariantCulture)}",
        PlcModel.FieldMode.Random => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)} mỗi giây",
        PlcModel.FieldMode.Sine => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)}, chu kỳ {g.Period.ToString("0.#", CultureInfo.InvariantCulture)} s",
        _ => $"{g.Min.ToString("0.###", CultureInfo.InvariantCulture)} … {g.Max.ToString("0.###", CultureInfo.InvariantCulture)}, bước {g.Step.ToString("0.###", CultureInfo.InvariantCulture)}/s",
    };

    static readonly string[] ModeNames = { "Cố định", "Ngẫu nhiên trong khoảng", "Sóng sin", "Tăng dần" };
    static string ModeName(PlcModel.FieldMode m) => ModeNames[m switch { PlcModel.FieldMode.Fixed => 0, PlcModel.FieldMode.Random => 1, PlcModel.FieldMode.Sine => 2, _ => 3 }];

    string Sig() => string.Join("|", Streams().Select(s => $"{s.Child}.{s.Field}@{s.Addr}x{s.Scale}:{s.Kind}/{s.Access}/{s.Param}/{s.Type}/{s.Swap}/{s.Group}:{_model.ModeOf(s.Child, s.Field)}"));

    void RefreshStreams()
    {
        _sig = Sig();
        var keep = _streams.CurrentRow?.Index ?? -1;
        _streams.Rows.Clear();
        var vals = _model.Fields().ToDictionary(f => (f.Child, f.Field), f => f.Value);
        foreach (var s in Streams())
        {
            var g = _model.ModeOf(s.Child, s.Field);
            _streams.Rows.Add(s.Child, s.Group, s.Field, TypeName(s.Type), ShortOf(s.Kind), AccessName(s.Access), DRange(s.Addr, s.Type),
                s.Addr >= 0 ? ProtoParams.Address(s.Kind, s.Addr, s.Param, s.Child, s.Field) : "—", s.Addr >= 0 ? s.Scale.ToString(CultureInfo.InvariantCulture) : "—",
                ModeName(g.Mode), GenText(g, vals[(s.Child, s.Field)]), "");
        }
        _empty.Visible = _streams.Rows.Count == 0;
        if (keep >= 0 && keep < _streams.Rows.Count) _streams.CurrentCell = _streams.Rows[keep].Cells[0];
    }

    /// <summary>Các thanh ghi D đang bị chiếm (kể cả word thứ 2, 3, 4 của kiểu dài), trừ luồng/struct đang sửa.</summary>
    HashSet<int> UsedWords(Func<Stream, bool> except)
    {
        var used = new HashSet<int>();
        foreach (var s in Streams().Where(x => !except(x) && x.Addr >= 0))
            for (var i = 0; i < PlcModel.Words(s.Type); i++) used.Add(s.Addr + i);
        return used;
    }

    static bool InSame(Stream a, Stream? e) => e != null && a.Child == e.Child && (e.Group.Length > 0 ? a.Group == e.Group : a.Group.Length == 0 && a.Field == e.Field);

    StreamDialog NewStreamDialog(Stream? edit)
    {
        var used = UsedWords(x => InSame(x, edit));
        var children = Streams().Select(s => s.Child).Distinct().ToArray();
        var protos = Protos.Select(p => (p.Label, p.Kind)).ToArray();
        var kind = edit?.Kind ?? Protos[Math.Clamp(_protoSel, 0, Protos.Length - 1)].Kind;
        var all = Streams().Select(s => (s.Child, s.Field)).ToHashSet();
        if (edit != null && edit.Group.Length > 0)
        {
            var vals = _model.Fields().ToDictionary(f => (f.Child, f.Field), f => f.Value);
            var mem = Streams().Where(x => InSame(x, edit)).OrderBy(x => x.Addr)
                .Select(x => new StructMember(x.Field, x.Type, x.Scale, _model.ModeOf(x.Child, x.Field), vals[(x.Child, x.Field)])).ToList();
            var first = Streams().Where(x => InSame(x, edit)).OrderBy(x => x.Addr).First();
            return new StreamDialog(edit.Child, edit.Group, first.Addr, 1, new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), 0, used, children, all, true, protos, kind, edit.Access, edit.Param, PlcModel.DataType.UInt16, edit.Swap, edit.Group, mem);
        }
        var cur = edit == null ? 0 : _model.Fields().First(f => f.Child == edit.Child && f.Field == edit.Field).Value;
        return new StreamDialog(edit?.Child, edit?.Field, edit?.Addr ?? -1, edit?.Scale ?? 10, edit == null ? new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100) : _model.ModeOf(edit.Child, edit.Field), cur, used, children, all, edit != null,
            protos, kind, edit?.Access ?? PlcModel.Access.ReadWrite, edit?.Param ?? "", edit?.Type ?? PlcModel.DataType.UInt16, edit?.Swap ?? false);
    }

    void AddOrEditStream(Stream? edit)
    {
        using var d = NewStreamDialog(edit);
        if (_demoHook != null) { var hook = _demoHook; d.Window.Shown += (_, _) => hook(d); }
        if (d.ShowDialog(this) != DialogResult.OK) return;
        if (edit != null && edit.Group.Length > 0)   // sửa struct: bỏ các thành viên cũ rồi tạo lại theo bảng mới
            foreach (var m in Streams().Where(x => InSame(x, edit)).ToList()) _model.RemoveField(m.Child, m.Field);
        ApplyStream(d);
    }

    void ApplyStream(StreamDialog d)
    {
        if (d.IsStruct)
        {
            var a = d.Addr;
            foreach (var m in d.Members)
            {
                _model.SetMeta(d.Child, m.Name, new PlcModel.Meta(d.Kind, d.AccessMode, d.Param, m.Type, d.Swap, d.Field));
                _model.MapField(d.Child, m.Name, a, m.Scale);
                _model.SetMode(d.Child, m.Name, m.Gen);
                _model.SetField(d.Child, m.Name, m.Value, "ui");
                a += PlcModel.Words(m.Type);
            }
            AppendLog($"UI: struct {d.Child}.{d.Field} ({d.Members.Count} thành viên, {DRange(d.Addr, PlcModel.DataType.UInt16)}–D{a - 1}) → {ShortOf(d.Kind)}, {AccessName(d.AccessMode)}");
        }
        else
        {
            _model.SetMeta(d.Child, d.Field, new PlcModel.Meta(d.Kind, d.AccessMode, d.Param, d.DType, d.Swap));   // kiểu phải có trước khi gắn D để ghi đúng số word
            _model.MapField(d.Child, d.Field, d.Addr, d.Scale);
            _model.SetMode(d.Child, d.Field, d.Gen);
            _model.SetField(d.Child, d.Field, d.Value, "ui");
            AppendLog($"UI: luồng {d.Child}.{d.Field} [{TypeName(d.DType)}] → {ShortOf(d.Kind)} {ProtoParams.Address(d.Kind, d.Addr, d.Param, d.Child, d.Field)}, {AccessName(d.AccessMode)}, {ModeName(d.Gen.Mode)}");
        }
        _protoSel = Array.FindIndex(Protos, p => p.Kind == d.Kind);
        RefreshStreams();
        if (_eps.Count > 0 && _eps.All(e => e.Kind != d.Kind)) _ = StartKindAsync(d.Kind);   // đang chạy: bật thêm giao thức mới
    }

    void DeleteStream()
    {
        var s = SelectedStream();
        if (s == null) { AppendLog("Chọn một dòng luồng dữ liệu cần xoá."); return; }
        var grp = s.Group.Length > 0 ? Streams().Where(x => InSame(x, s)).ToList() : new List<Stream> { s };
        var what = s.Group.Length > 0 ? $"cả struct {s.Child}.{s.Group} ({grp.Count} thành viên)" : $"luồng {s.Child}.{s.Field} ({DRange(s.Addr, s.Type)})";
        if (!Ask.Yes(this, $"Xoá {what}?" + "\n\n" + "Gateway đang đọc sẽ nhận 0.", "Xác nhận xoá luồng dữ liệu")) return;
        foreach (var m in grp) _model.RemoveField(m.Child, m.Field);
        AppendLog($"UI: đã xoá {what}");
        RefreshStreams();
    }

    // ------------------------------------------------------------------ giao thức
    void UpdateSummary()
    {
        var kinds = Streams().Select(x => x.Kind).Distinct().ToArray();
        _summary.Text = kinds.Length == 0 ? "Chưa có luồng" : string.Join(" · ", kinds.Select(k => $"{ShortOf(k)} :{Cfg(k).Port}"));
    }

    void EditProtocol()
    {
        using var d = new ProtocolDialog(Protos.Select(p => (p.Label, p.Kind, p.Port, p.HostLabel, p.GatewayHint)).ToArray(), _protoSel, _cfg);
        if (d.ShowDialog(this) != DialogResult.OK) return;
        foreach (var (k, v) in d.Result) _cfg[k] = v;
        UpdateSummary();
        if (_eps.Count > 0) AppendLog("Đã lưu kết nối; dừng rồi bắt đầu lại để áp dụng.");
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
                var k = (Convert.ToString(r.Cells[0].Value) ?? "", Convert.ToString(r.Cells[2].Value) ?? "");
                if (!vals.TryGetValue(k, out var v)) continue;
                r.Cells[11].Value = v.ToString("0.###", CultureInfo.InvariantCulture);
                var g = _model.ModeOf(k.Item1, k.Item2);
                if (g.Mode == PlcModel.FieldMode.Fixed) r.Cells[10].Value = GenText(g, v);
            }
            if (!_regs.IsCurrentCellInEditMode)
                foreach (DataGridViewRow r in _regs.Rows)
                {
                    var v = _model.Get(Convert.ToInt32(r.Cells[0].Value));
                    if (Convert.ToString(r.Cells[2].Value) != v.ToString()) r.Cells[2].Value = v.ToString();
                }
        }
        finally { _refreshing = false; }
        _status.Text = _eps.Count == 0 ? "Đã dừng" : "● Đang chạy: " + string.Join(" · ", _eps.Select(e => $"{ShortOf(e.Kind)} ({(e.Kind == "mqtt" ? (e.Ep.Peers > 0 ? "đã nối" : "chưa nối") : $"{e.Ep.Peers} kết nối")})"));
        _status.ForeColor = _eps.Count == 0 ? Color.Gray : _eps.Any(e => e.Ep.Peers > 0) ? Color.ForestGreen : Color.DarkOrange;
    }

    // ------------------------------------------------------------------ chạy / dừng
    IEndpoint CreateEndpoint(string kind)
    {
        void Log(string s) => AppendLog(s);
        var c = Cfg(kind); var host = c.Host.Trim();
        // tag/symbol: lấy từ thông số của luồng đầu tiên dùng giao thức này, không có thì dùng mặc định ở "Kết nối…"
        var key = kind == "eip" ? "tag" : kind == "ads" ? "symbol" : null;
        var tag = key == null ? c.Tag : Streams().Where(x => x.Kind == kind).Select(x => ProtoParams.Get(x.Param, kind, key)).FirstOrDefault(v => v.Length > 0) ?? c.Tag;
        return kind switch
        {
            "modbus" => new ModbusTcpSlave(_model, host, c.Port, Log),
            "mc" => new MitsubishiMcServer(_model, host, c.Port, Log),
            "fins-udp" => new OmronFinsServer(_model, host, c.Port, false, Log),
            "fins-tcp" => new OmronFinsServer(_model, host, c.Port, true, Log),
            "s7" => new S7Server(_model, host, c.Port, Log),
            "eip" => new EtherNetIpServer(_model, host, c.Port, tag, Log),
            "ads" => new BeckhoffAdsServer(_model, host, c.Port, tag, Log),
            "opcua" => new OpcUaPlcServer(_model, host, c.Port, Log),
            "mqtt" => new MqttGatewayLink(_model, host, c.Port, c.User.Trim(), c.Pass, c.Site.Trim(), c.Device.Trim(), Log),
            _ => throw new InvalidOperationException(),
        };
    }

    async Task<bool> StartKindAsync(string kind)
    {
        IEndpoint? ep = null;
        try
        {
            ep = CreateEndpoint(kind);
            await ep.StartAsync();
        }
        catch (Exception ex)
        {
            AppendLog($"Không khởi động được {ShortOf(kind)}: {ex.Message}");
            if (ep != null) { try { await ep.DisposeAsync(); } catch (Exception) { /* bỏ qua */ } }
            return false;
        }
        _eps.Add((kind, ep));
        SetRunning(true);
        if (kind == "mqtt") await PushAsync();
        return true;
    }

    async Task ToggleAsync()
    {
        if (_eps.Count > 0) { await StopAsync(); return; }
        var kinds = Streams().Select(x => x.Kind).Distinct().ToArray();
        if (kinds.Length == 0) { AppendLog("Chưa có luồng dữ liệu nào: bấm ＋ Thêm luồng dữ liệu và chọn giao thức trước."); return; }
        foreach (var k in kinds)
            if (!await StartKindAsync(k)) { await StopAsync(); return; }
        _sendTimer.Interval = Math.Max(200, kinds.Contains("mqtt") ? Cfg("mqtt").Interval : 1000);
        _sendTimer.Start();
    }

    async Task StopAsync()
    {
        _sendTimer.Stop();
        var eps = _eps.ToArray(); _eps.Clear();
        foreach (var (_, ep) in eps) { try { await ep.DisposeAsync(); } catch (Exception) { /* bỏ qua */ } }
        if (eps.Length > 0) AppendLog("Đã dừng.");
        SetRunning(false);
    }

    void SetRunning(bool run)
    {
        _start.Text = run ? "■ Dừng" : "▶ Bắt đầu";
        _sendNow.Enabled = run;
    }

    async Task PushAsync()
    {
        if (_eps.Count == 0 || _busy) return;
        _busy = true;
        try { foreach (var (_, ep) in _eps.ToArray()) await ep.PushAsync(); }
        catch (Exception ex) { AppendLog($"Gửi lỗi: {ex.Message}"); }
        finally { _busy = false; }
    }

    // Mọi ghi từ gateway (gốc là webapp/cloud hoặc HMI) hiện thành một dòng trong tab "Lệnh nhận từ gateway".
    void OnModelChanged(string desc, string origin)
    {
        if (origin == "denied") { AppendLog(desc); return; }
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
        /// <summary>Kết nối theo mã giao thức (không lưu password).</summary>
        public Dictionary<string, ProtoCfg> Cfgs { get; set; } = new();
        /// <summary>Mỗi dòng: child, field, giá trị, D, hệ số, chế độ (tên enum), min, max, chu kỳ, bước, giao thức, quyền, thông số giao thức.</summary>
        public List<string[]> Fields { get; set; } = new();
    }

    void SaveSettings()
    {
        try
        {
            var s = new Saved
            {
                Proto = _protoSel,
                Cfgs = _cfg.ToDictionary(kv => kv.Key, kv => { var c = kv.Value.Clone(); c.Pass = ""; return c; }),
                Fields = _model.Fields().Select(f =>
                {
                    var m = _model.MapOf(f.Child, f.Field); var g = _model.ModeOf(f.Child, f.Field); var mt = _model.MetaOf(f.Child, f.Field);
                    string N(double d) => d.ToString(CultureInfo.InvariantCulture);
                    return new[] { f.Child, f.Field, N(f.Value), m?.Addr.ToString() ?? "", m == null ? "" : N(m.Value.Scale), g.Mode.ToString(), N(g.Min), N(g.Max), N(g.Period), N(g.Step),
                        mt?.Kind ?? "modbus", (mt?.Access ?? PlcModel.Access.ReadWrite).ToString(), mt?.Param ?? "",
                        (mt is { Kind: not null } m2 ? m2.Type : PlcModel.DataType.UInt16).ToString(), (mt?.WordSwap ?? false).ToString(), mt?.Group ?? "" };
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
            _protoSel = Math.Clamp(s.Proto, 0, Protos.Length - 1);
            foreach (var (k, v) in s.Cfgs) if (Protos.Any(p => p.Kind == k) && v.Port is >= 1 and <= 65535) _cfg[k] = v;
            double D(string[] r, int i, double dflt) => r.Length > i && double.TryParse(r[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var x) ? x : dflt;
            foreach (var f in s.Fields.Where(f => f.Length >= 3))
            {
                if (!double.TryParse(f[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) continue;
                var da = f.Length >= 5 && int.TryParse(f[3], out var a0) ? a0 : -1;
                var sc = D(f, 4, 1);
                _model.MapField(f[0], f[1], da, sc);
                // file cũ (5 cột) không có chế độ: mặc định cố định
                if (f.Length >= 8 && Enum.TryParse<PlcModel.FieldMode>(f[5], out var mode))
                    _model.SetMode(f[0], f[1], new PlcModel.Gen(mode, D(f, 6, 0), D(f, 7, 100), D(f, 8, 60), D(f, 9, 1)));
                // file cũ chưa có giao thức/quyền: Modbus TCP, đọc/ghi
                var kind = f.Length >= 11 && Protos.Any(p => p.Kind == f[10]) ? f[10] : "modbus";
                var acc = f.Length >= 12 && Enum.TryParse<PlcModel.Access>(f[11], out var ac) ? ac : PlcModel.Access.ReadWrite;
                var ty = f.Length >= 14 && Enum.TryParse<PlcModel.DataType>(f[13], out var t0) ? t0 : PlcModel.DataType.UInt16;
                _model.SetMeta(f[0], f[1], new PlcModel.Meta(kind, acc, f.Length >= 13 ? f[12] : "", ty, f.Length >= 15 && f[14] == "True", f.Length >= 16 ? f[15] : ""));
                _model.MapField(f[0], f[1], da, sc);   // gắn lại sau khi có kiểu để ảnh D đúng số word
                _model.SetField(f[0], f[1], v, "ui");
            }
        }
        catch (Exception e) when (e is IOException or JsonException) { /* file hỏng: dùng mặc định rỗng */ }
    }
}
