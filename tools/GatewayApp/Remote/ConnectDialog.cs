using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Chọn thiết bị trong LAN (tự tìm bằng broadcast UDP) hoặc nhập IP.
///   Board Waveshare (HTTPS 443): KHÔNG mã — đăng nhập bằng khoá của PC này. Board lạ: đối chiếu mã phần cứng với tem MỘT lần (ghim).
///     PC chưa ghép: nhấn BOOT trên board (người cầm thiết bị được ưu tiên) rồi "Thử lại", hoặc đăng nhập webapp của chủ board.
///   Gateway PC (cổng 8750): mã kết nối đang hiện ở trang "Kết nối admin" của máy đó.
/// </summary>
sealed class ConnectDialog : Form
{
    readonly ListView _list = new() { View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, Dock = DockStyle.Fill, BackColor = Theme.Panel, ForeColor = Theme.Text, BorderStyle = BorderStyle.None };
    readonly TextBox _host = new() { Width = 200 }, _code = new() { Width = 140, MaxLength = 8 };
    readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Value = 443, Width = 90 };   // Waveshare: 443 (gateway PC: 8750) — chọn trong danh sách thì tự điền
    readonly Label _codeLbl = new() { Text = "Mã kết nối (chỉ gateway PC)", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(4, 9, 2, 0) };
    readonly Label _msg = new() { AutoSize = false, Dock = DockStyle.Bottom, Height = 52, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(14, 4, 14, 0) };
    readonly FlatButton _go = new() { Caption = "Kết nối", Primary = true, Width = 120 };
    readonly FlatButton _scan = new() { Caption = "Tìm lại", Width = 90 };
    readonly FlatButton _retry = new() { Caption = "Đã nhấn BOOT — thử lại", Width = 200, Visible = false };
    readonly FlatButton _web = new() { Caption = "Đăng nhập webapp…", Width = 160, Visible = false };
    readonly Dictionary<string, ApiHello> _found = new();
    readonly FlowLayoutPanel _manual = new() { Dock = DockStyle.Bottom, Height = 44, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg, WrapContents = true, Visible = false };
    readonly LinkLabel _manualLink = new() { Text = "Nhập IP thủ công…", AutoSize = true, LinkColor = Theme.Accent, Margin = new Padding(4, 10, 8, 0) };
    bool _autoDone, _presetHost;
    public (RemoteClient Client, ApiHello Hello, string Host, int Port, ApiConfig Config)? Result { get; private set; }

    bool IsMcu => _found.TryGetValue($"{_host.Text.Trim()}:{(int)_port.Value}", out var h) ? h.Tls || h.Kind == "mcu" : (int)_port.Value == 443;

    ConnectDialog(string host, int port, string code, string? note)
    {
        Text = "Kết nối thiết bị qua mạng LAN"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(680, 470);

        var top = new Label { Dock = DockStyle.Top, Height = 66, ForeColor = Theme.Text, Padding = new Padding(14, 10, 14, 0), UseMnemonic = false,
            Text = note ?? "Chọn board Waveshare (hoặc gateway PC) trong danh sách rồi bấm Kết nối. Board Waveshare không cần mã: PC này đăng nhập bằng khoá riêng qua kênh mã hoá.\nLần đầu với một board: nhấn nút BOOT trên board để ghép PC này (chỉ một lần)." };
        _list.Columns.Add("Loại", 95); _list.Columns.Add("Tên", 160); _list.Columns.Add("Địa chỉ", 150); _list.Columns.Add("Mạng", 120); _list.Columns.Add("Phiên bản", 95);
        _list.SelectedIndexChanged += (_, _) =>
        {
            if (_list.SelectedItems.Count == 0) return;
            var k = (string)_list.SelectedItems[0].Tag!; var i = k.LastIndexOf(':');
            _host.Text = k[..i]; _port.Value = int.Parse(k[(i + 1)..]);
            SyncKind();
            if (!RemoteClient.SameSubnetAsThisPc(_host.Text))
            {
                _msg.ForeColor = Theme.Yellow;
                _msg.Text = $"Board ở {_host.Text} KHÁC mạng con với PC (mặc định của board: 192.168.1.200). Thêm cho card mạng PC một IP cùng dải (vd. 192.168.1.10/24) để kết nối, rồi đổi IP board bằng nút \"Mạng (IP)…\".";
            }
        };
        _list.DoubleClick += async (_, _) => await GoAsync();
        var listHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 4, 14, 8), BackColor = Theme.Bg };
        listHost.Controls.Add(_list);

        var form = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 56, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg, WrapContents = true };
        Control L(string t) => new Label { Text = t, AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(4, 9, 2, 0) };
        _host.Text = host; _port.Value = Math.Clamp(port, 1, 65535); _code.Text = code;
        _port.ValueChanged += (_, _) => SyncKind(); _host.TextChanged += (_, _) => SyncKind();
        // IP/cổng/mã chỉ là phương án dự phòng: chương trình TỰ TÌM thiết bị (UDP) và tự chọn; chỉ hiện khi không thấy gì hoặc người dùng muốn nhập tay
        _presetHost = host.Length > 0;
        _manual.Controls.AddRange(new Control[] { L("IP"), _host, L("Cổng (Waveshare 443 · gateway PC 8750)"), _port, _codeLbl, _code });
        _manualLink.LinkClicked += (_, _) => { _manual.Visible = true; _manualLink.Visible = false; };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 80 };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        _go.Click += async (_, _) => await GoAsync();
        _retry.Click += async (_, _) => await GoAsync();
        _web.Click += async (_, _) => await WebPairAsync();
        _scan.Click += async (_, _) => await ScanAsync();
        form.Controls.AddRange(new Control[] { _go, _retry, _web, _scan, _manualLink, cancel });
        _code.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await GoAsync(); } };

        Controls.Add(listHost); Controls.Add(_manual); Controls.Add(form); Controls.Add(_msg); Controls.Add(top);
        SyncKind();
        Shown += async (_, _) => await ScanAsync();
        _rescan.Tick += async (_, _) => { if (!IsDisposed && _list.Items.Count == 0 && _go.Enabled && _scan.Enabled) await ScanAsync(); };
        _rescan.Start();
        FormClosed += (_, _) => { _rescan.Stop(); _rescan.Dispose(); };
    }
    readonly System.Windows.Forms.Timer _rescan = new() { Interval = 4000 };

    void SyncKind() { var mcu = IsMcu; _code.Enabled = !mcu; _codeLbl.Enabled = !mcu; }

    async Task ScanAsync()
    {
        _scan.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = "Đang tìm thiết bị trong LAN…";
        try
        {
            var res = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(1.5));
            _list.Items.Clear(); _found.Clear();
            // một board có cả dây lẫn Wi-Fi trả lời từ 2 IP: gộp theo mã phần cứng, giữ địa chỉ cùng mạng con với PC (không có thì địa chỉ đầu)
            var shown = res.GroupBy(r => r.Hello.Kind == "mcu" && r.Hello.Hw.Length > 0 ? "mcu:" + r.Hello.Hw : r.Ip + ":" + r.Hello.Port)
                .Select(g => g.OrderByDescending(r => RemoteClient.SameSubnetAsThisPc(r.Ip.ToString())).ThenBy(r => r.Ip.ToString()).First()).ToList();
            foreach (var (ip, h) in shown)
            {
                var key = $"{ip}:{h.Port}";
                _found[key] = h;
                if (h.Kind == "mcu") TrustedBoards.SetProtocols(h.Hw, h.Protocols);
                var net = h.Ip.Length == 0 ? "" : RemoteClient.SameSubnetAsThisPc(ip.ToString()) ? "cùng mạng" : "⚠ khác mạng con";
                var trusted = h.Locked ? " 🔒 bị khoá" : h.Kind == "mcu" && TrustedBoards.Contains(h.Hw) ? " ✓" : "";
                var it = new ListViewItem(new[] { (h.Kind == "mcu" ? "Waveshare" : "Gateway PC") + trusted, h.Name, key, net, h.Version }) { Tag = key };
                if (net.StartsWith("⚠")) it.ForeColor = Theme.Yellow;
                if (h.Locked) it.ForeColor = Theme.Red;
                _list.Items.Add(it);
            }
            _msg.Text = shown.Count == 0 ? "Không thấy thiết bị nào trả lời (tường lửa chặn UDP 8751, board chưa cùng mạng, hoặc gateway PC chưa mở cho LAN). Đang tự tìm lại… hoặc nhập IP thủ công." : $"Tìm thấy {shown.Count} thiết bị. ✓ = board PC này đã tin cậy.";
            if (shown.Count == 0) { _manual.Visible = true; _manualLink.Visible = false; }
            SyncKind();
            // TỰ CHỌN: chỉ một board Waveshare (hoặc một board đã tin cậy) → chọn và nối luôn, người dùng không phải nhập/bấm gì. Chỉ tự nối một lần.
            if (!_autoDone && !IsDisposed && shown.Count > 0)
            {
                var mcus = shown.Where(r => r.Hello.Kind == "mcu" && !r.Hello.Locked).ToList();
                var pick = _presetHost ? shown.Where(r => r.Ip.ToString() == _host.Text.Trim()).Cast<(System.Net.IPAddress Ip, ApiHello Hello)?>().FirstOrDefault()
                    : mcus.Count == 1 ? mcus[0] : mcus.Count > 1 && mcus.Count(r => TrustedBoards.Contains(r.Hello.Hw)) == 1 ? mcus.First(r => TrustedBoards.Contains(r.Hello.Hw)) : null;
                if (pick is { } pk)
                {
                    _autoDone = true;
                    foreach (ListViewItem it in _list.Items) if ((string)it.Tag! == $"{pk.Ip}:{pk.Hello.Port}") { it.Selected = true; break; }
                    _msg.Text = $"Tự tìm thấy board {pk.Ip} — đang kết nối…";
                    await GoAsync();
                    return;
                }
            }
        }
        catch (Exception e) { _msg.Text = "Không tìm được: " + e.Message; }
        finally { if (!IsDisposed) _scan.Enabled = true; }
    }

    /// <summary>Board lạ trong LAN: không hỏi (LAN được tin, xem RemoteClient.ConnectMcuAsync).</summary>
    static bool ConfirmBoard(string hw) => true;

    /// <summary>Board đang thuộc chủ khác (bán / chuyển board): hỏi trước khi board xoá dữ liệu chủ cũ.</summary>
    internal static bool ConfirmWipe(IWin32Window? owner) =>
        Ask.Yes(owner, "Board này đang thuộc chủ khác (đã ghép với PC quản trị khác).\n\n" +
            "Để dùng trên PC này, board sẽ XOÁ toàn bộ dữ liệu của chủ cũ: cấu hình thiết bị, kết nối cloud, chương trình logic, nhật ký, các PC quản trị cũ. " +
            "Giữ nguyên cài đặt mạng. Board tự khởi động lại (~10 giây).\n\n" +
            "Nếu đây là board của bạn và bạn chỉ muốn thêm PC: bấm Không, rồi khôi phục bản sao lưu GatewayApp hoặc dùng \"Đăng nhập webapp…\".\n\n" +
            "Xoá dữ liệu cũ và dùng board?", "Board của chủ khác");

    async Task GoAsync(string webToken = "")
    {
        var host = _host.Text.Trim(); var code = _code.Text.Trim(); var port = (int)_port.Value;
        if (host.Length == 0) { Err("Chưa chọn thiết bị: chọn trong danh sách, hoặc nhập IP thủ công."); _manual.Visible = true; _manualLink.Visible = false; return; }
        var mcu = IsMcu;
        if (!mcu && code.Length == 0) { Err("Gateway PC: nhập mã kết nối ở trang \"Kết nối admin\" của máy đó."); return; }
        if (mcu && RemoteForm.IdentityProvider == null) { Err("Chưa có khoá của PC này (mở từ GatewayApp)."); return; }
        _go.Enabled = _retry.Enabled = _web.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = $"Đang nối {host}:{port}{(mcu ? " (HTTPS)" : "")}…";
        RemoteClient? c = null;
        try
        {
            var paired = false;
            if (mcu) (c, paired) = await RemoteClient.ConnectMcuAsync(host, port, RemoteForm.IdentityProvider!(), ConfirmBoard, webToken, confirmWipe: () => ConfirmWipe(this));
            else c = await RemoteClient.ConnectAsync(host, port, code);
            var cfg = await c.ConfigAsync();
            _ = await c.StateAsync();   // kiểm tra phiên dùng được trước khi mở cửa sổ
            var hello = _found.TryGetValue($"{host}:{port}", out var h) ? h : new ApiHello { Kind = mcu ? "mcu" : "pc", Port = port, Tls = mcu, Hw = c.ObservedHw };
            if (hello.Name.Length == 0 && cfg.Config.MqttId.Length > 0) hello.Name = $"{cfg.Config.Site}/{cfg.Config.Device}";
            if (paired) RemoteForm.PendingNote = "Đã ghép PC này với board — lần sau vào thẳng, không cần nhấn BOOT.";
            Result = (c, hello, host, port, cfg);
            DialogResult = DialogResult.OK; Close();
        }
        catch (Exception e)
        {
            c?.Dispose();
            var code2 = (e as RemoteException)?.Code;
            var needPair = code2 is "not_paired" or "not_owner" or "board_not_registered" or "server_unreachable";
            _retry.Visible = _web.Visible = needPair;
            Err(RemoteClient.Explain(e));
        }
        finally { if (!IsDisposed) _go.Enabled = _retry.Enabled = _web.Enabled = true; }
    }

    /// <summary>Không với tới board để nhấn BOOT: chủ board đăng nhập webapp (duyệt trên điện thoại / OTP); board tự hỏi server xác nhận rồi ghép PC.</summary>
    async Task WebPairAsync()
    {
        using var f = new LoginForm(CloudPage.DefaultServer, "Đăng nhập webapp", "Xác nhận chủ board để ghép PC này (thay cho nhấn nút BOOT)");
        if (f.ShowDialog(this) != DialogResult.OK || f.Result == null) return;
        await GoAsync(f.Result.Token);
    }

    void Err(string t) { _msg.ForeColor = Theme.Red; _msg.Text = t; }

    public static (RemoteClient Client, ApiHello Hello, string Host, int Port, ApiConfig Config)? Run(IWin32Window owner, string host, int port, string code, string? note = null)
    {
        using var d = new ConnectDialog(host, port, code, note);
        return d.ShowDialog(owner) == DialogResult.OK ? d.Result : null;
    }
}
