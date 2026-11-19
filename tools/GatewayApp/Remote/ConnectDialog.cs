using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Chọn thiết bị trong LAN (tự tìm bằng broadcast UDP) hoặc nhập IP, rồi nhập mã kết nối 8 số đang hiện trên thiết bị
/// (Waveshare: in ra cổng USB-serial và trang trạng thái; gateway PC: trang "Kết nối admin").
/// </summary>
sealed class ConnectDialog : Form
{
    readonly ListView _list = new() { View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, Dock = DockStyle.Fill, BackColor = Theme.Panel, ForeColor = Theme.Text, BorderStyle = BorderStyle.None };
    readonly TextBox _host = new() { Width = 200 }, _code = new() { Width = 140, MaxLength = 8 };
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Value = 8750, Width = 90 };
    readonly Label _msg = new() { AutoSize = false, Dock = DockStyle.Bottom, Height = 40, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(14, 4, 14, 0) };
    readonly FlatButton _go = new() { Caption = "Kết nối", Primary = true, Width = 130 };
    readonly FlatButton _scan = new() { Caption = "Tìm lại", Width = 100 };
    readonly Dictionary<string, ApiHello> _found = new();
    public (RemoteClient Client, ApiHello Hello, string Host, int Port, ApiConfig Config)? Result { get; private set; }

    ConnectDialog(string host, int port, string code, string? note)
    {
        Text = "Kết nối thiết bị qua mạng LAN"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(640, 470);

        var top = new Label { Dock = DockStyle.Top, Height = 66, ForeColor = Theme.Text, Padding = new Padding(14, 10, 14, 0), UseMnemonic = false,
            Text = note ?? "Gateway Waveshare (ESP32-S3) hoặc gateway PC đã bật \"Kết nối admin\" trong cùng mạng LAN. Chọn trong danh sách hoặc nhập IP, rồi nhập mã kết nối.\nWaveshare: mã 8 số in trên tem; nhấn nút BOOT trên board để mở cài đặt 10 phút." };
        _list.Columns.Add("Loại", 110); _list.Columns.Add("Tên", 210); _list.Columns.Add("Địa chỉ", 170); _list.Columns.Add("Phiên bản", 110);
        _list.SelectedIndexChanged += (_, _) =>
        {
            if (_list.SelectedItems.Count == 0) return;
            var k = (string)_list.SelectedItems[0].Tag!; var i = k.LastIndexOf(':');
            _host.Text = k[..i]; _port.Value = int.Parse(k[(i + 1)..]); _code.Focus();
        };
        _list.DoubleClick += (_, _) => _code.Focus();
        var listHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 4, 14, 8), BackColor = Theme.Bg };
        listHost.Controls.Add(_list);

        var form = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 96, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg, WrapContents = true };
        Control L(string t) => new Label { Text = t, AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(4, 9, 2, 0) };
        _host.Text = host; _port.Value = Math.Clamp(port, 1, 65535); _code.Text = code;
        form.Controls.AddRange(new Control[] { L("IP"), _host, L("Cổng"), _port, L("Mã kết nối"), _code });
        form.SetFlowBreak(_code, true);
        var cancel = new FlatButton { Caption = "Huỷ", Width = 100 };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        _go.Click += async (_, _) => await GoAsync();
        _scan.Click += async (_, _) => await ScanAsync();
        form.Controls.AddRange(new Control[] { _go, _scan, cancel });
        AcceptButton = null;
        _code.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await GoAsync(); } };

        Controls.Add(listHost); Controls.Add(form); Controls.Add(_msg); Controls.Add(top);
        Shown += async (_, _) => { if (host.Length > 0) _code.Focus(); await ScanAsync(); };
    }

    async Task ScanAsync()
    {
        _scan.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = "Đang tìm thiết bị trong LAN…";
        try
        {
            var res = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(1.5));
            _list.Items.Clear(); _found.Clear();
            foreach (var (ip, h) in res)
            {
                var key = $"{ip}:{h.Port}";
                _found[key] = h;
                var it = new ListViewItem(new[] { h.Kind == "mcu" ? "Waveshare" : "Gateway PC", h.Name, key, h.Version }) { Tag = key };
                _list.Items.Add(it);
            }
            _msg.Text = res.Count == 0 ? "Không thấy thiết bị nào trả lời (khác mạng con, tường lửa chặn UDP 8751, hoặc gateway PC chưa mở cho LAN). Vẫn nhập IP tay được." : $"Tìm thấy {res.Count} thiết bị.";
        }
        catch (Exception e) { _msg.Text = "Không tìm được: " + e.Message; }
        finally { if (!IsDisposed) _scan.Enabled = true; }
    }

    async Task GoAsync()
    {
        var host = _host.Text.Trim(); var code = _code.Text.Trim(); var port = (int)_port.Value;
        if (host.Length == 0) { Err("Nhập IP của thiết bị."); return; }
        if (code.Length == 0) { Err("Nhập mã kết nối đang hiện trên thiết bị."); return; }
        _go.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = $"Đang nối {host}:{port}…";
        RemoteClient? c = null;
        try
        {
            c = await RemoteClient.ConnectAsync(host, port, code);
            var cfg = await c.ConfigAsync();
            _ = await c.StateAsync();   // kiểm tra phiên dùng được trước khi mở cửa sổ
            var hello = _found.TryGetValue($"{host}:{port}", out var h) ? h : new ApiHello { Kind = "pc", Port = port };
            if (hello.Name.Length == 0 && cfg.Config.MqttId.Length > 0) hello.Name = $"{cfg.Config.Site}/{cfg.Config.Device}";
            Result = (c, hello, host, port, cfg);
            DialogResult = DialogResult.OK; Close();
        }
        catch (Exception e) { c?.Dispose(); Err(RemoteClient.Explain(e)); }
        finally { if (!IsDisposed) _go.Enabled = true; }
    }

    void Err(string t) { _msg.ForeColor = Theme.Red; _msg.Text = t; }

    public static (RemoteClient Client, ApiHello Hello, string Host, int Port, ApiConfig Config)? Run(IWin32Window owner, string host, int port, string code, string? note = null)
    {
        using var d = new ConnectDialog(host, port, code, note);
        return d.ShowDialog(owner) == DialogResult.OK ? d.Result : null;
    }
}
