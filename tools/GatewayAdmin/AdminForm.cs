using GatewayApp;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// Tool admin: nối tới gateway của khách bằng IP:cổng + token. Thêm/sửa/xoá thiết bị và giao thức ở đây
/// → tự gửi sang gateway (gateway lưu và khởi động lại luồng đọc). Xem và điều khiển cũng đi qua gateway.
/// </summary>
public sealed class AdminForm : Form
{
    readonly RemoteGateway _gw = new();
    readonly Panel _side = new() { Dock = DockStyle.Left, Width = 210, BackColor = Theme.Side };
    readonly Panel _head = new() { Dock = DockStyle.Top, Height = 62, BackColor = Theme.Bg };
    readonly Panel _body = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg };
    readonly Label _title = new() { ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(22, 12), BackColor = Color.Transparent };
    readonly TextBox _addr = new() { Text = "127.0.0.1:8750", Width = 170 };
    readonly TextBox _token = new() { Width = 130, MaxLength = 24 };
    readonly Label _lblAddr = Skin.Lbl("Gateway (IP:cổng)");
    readonly Label _lblToken = Skin.Lbl("Mã kết nối");
    readonly FlatButton _connect = new() { Caption = "Kết nối", Primary = true, Width = 100 };
    readonly FlatButton _run = new() { Caption = "▶  Chạy", Width = 100 };
    readonly StatusChip _chip = new() { Caption = "Chưa kết nối" };
    readonly Label _toast = new() { AutoSize = false, Height = 40, Visible = false, ForeColor = Color.White, BackColor = Theme.Accent, Font = Theme.Semi, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0) };
    readonly System.Windows.Forms.Timer _poll = new() { Interval = 1000 };
    readonly System.Windows.Forms.Timer _toastTimer = new() { Interval = 4000 };
    readonly DashboardPage _dash;
    readonly DevicesPage _devices;
    readonly ProtocolsPage _protos;
    readonly List<(NavButton Btn, Control Page, string Title)> _pages = new();
    Control _current = null!;
    int _fails;

    public AdminForm()
    {
        Text = "Plciot ADMIN (tool cài đặt) — thiết lập gateway của khách từ xa";
        Width = 1400; Height = 860; MinimumSize = new Size(1100, 700); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; DoubleBuffered = true;
        _dash = new DashboardPage(_gw) { Dock = DockStyle.Fill };
        _devices = new DevicesPage(_gw) { Dock = DockStyle.Fill };
        _protos = new ProtocolsPage(_gw) { Dock = DockStyle.Fill };
        _gw.ToastRaised += Toast;

        Skin.Input(_addr); Skin.Input(_token);

        var logo = new Label { Text = "Admin", ForeColor = Theme.Text, Font = new Font("Segoe UI Semibold", 17f), AutoSize = false, Dock = DockStyle.Top, Height = 62, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(20, 0, 0, 0), BackColor = Theme.Side };
        var sub = new Label { Text = "PLCIOT · TOOL CÀI ĐẶT", ForeColor = Theme.Muted, Font = new Font("Segoe UI", 7.5f), AutoSize = false, Dock = DockStyle.Top, Height = 20, Padding = new Padding(22, 0, 0, 0), BackColor = Theme.Side };
        var items = new (string Icon, string Name, Control Page)[] { ("▦", "Tổng quan", _dash), ("⚙", "Thiết bị", _devices), ("⇄", "Giao thức", _protos) };
        foreach (var (icon, name, page) in items)
        {
            var b = new NavButton { Icon = icon, Caption = name };
            var p = page;
            b.Click += (_, _) => Show(p);
            _pages.Add((b, page, name)); page.Visible = false; _body.Controls.Add(page);
        }
        for (var i = _pages.Count - 1; i >= 0; i--) _side.Controls.Add(_pages[i].Btn);
        _side.Controls.Add(sub); _side.Controls.Add(logo);

        foreach (var c in new Control[] { _title, _lblAddr, _addr, _lblToken, _token, _connect, _run, _chip }) _head.Controls.Add(c);
        _run.Visible = false;
        _head.Resize += (_, _) => LayoutHead();
        _connect.Click += async (_, _) => { if (_gw.Connected) Disconnect(); else await ConnectAsync(_addr.Text.Trim()); };
        _run.Click += async (_, _) => { var e = await _gw.SetRunAsync(!_gw.Running); if (e != null) Toast("Không đổi được trạng thái: " + e, true); };
        Controls.Add(_body); Controls.Add(_head); Controls.Add(_side); Controls.Add(_toast);
        Resize += (_, _) => PlaceToast();
        _toastTimer.Tick += (_, _) => { _toast.Visible = false; _toastTimer.Stop(); };
        _poll.Tick += async (_, _) => await TickAsync();
        _poll.Start();
        LayoutHead();
        Show(_dash);
    }

    public string Token { get => _token.Text; set => _token.Text = value; }

    void LayoutHead()
    {
        // các ô kết nối bám mép phải, từ phải sang trái
        var x = _head.Width - 18;
        foreach (var c in new Control[] { _chip, _run, _connect, _token, _lblToken, _addr, _lblAddr })
        {
            if (c == _run && !_gw.Connected) continue;
            x -= c.Width + 8;
            c.Location = new Point(x, c is StatusChip ? 17 : c is FlatButton ? 14 : c is Label ? 20 : 16);
        }
    }

    void Show(Control page)
    {
        _current = page;
        foreach (var (btn, p, title) in _pages)
        {
            var on = p == page; btn.Selected = on; btn.Invalidate(); p.Visible = on;
            if (on) _title.Text = title;
        }
        page.BringToFront();
    }

    public async Task ConnectAsync(string address)
    {
        _connect.Enabled = false;
        try
        {
            await _gw.ConnectAsync(address, _token.Text.Replace(" ", "").Trim());
            _addr.Text = address; _fails = 0;
            _dash.Rebuild();
            Toast($"Đã kết nối gateway {address}: {_gw.Config.Pack.Count} field");
        }
        catch (Exception e) { Toast("Không kết nối được: " + (e is HttpRequestException ? $"gateway không phản hồi tại {address} — trên gateway, vào \"Kết nối admin\" và bật cho phép cài đặt" : e.Message), true); }
        finally { _connect.Enabled = true; UpdateChrome(); }
    }

    void Disconnect() { _gw.Disconnect(); UpdateChrome(); Toast("Đã ngắt kết nối."); }

    void UpdateChrome()
    {
        _connect.Caption = _gw.Connected ? "Ngắt" : "Kết nối"; _connect.Primary = !_gw.Connected; _connect.Invalidate();
        _addr.Enabled = _token.Enabled = !_gw.Connected;
        _run.Visible = _gw.Connected;
        _run.Caption = _gw.Running ? "■  Dừng" : "▶  Chạy"; _run.Danger = _gw.Running; _run.Primary = !_gw.Running; _run.Invalidate();
        _chip.Caption = !_gw.Connected ? "Chưa kết nối" : _gw.Running ? $"Gateway: {_gw.Status}" : "Gateway: dừng";
        _chip.Dot = !_gw.Connected ? Theme.Muted : !_gw.Running ? Theme.Yellow : _gw.Status == "online" ? Theme.Green : Theme.Yellow;
        LayoutHead();
    }

    async Task TickAsync()
    {
        if (_gw.Connected)
        {
            if (await _gw.PollAsync()) _fails = 0;
            else if (++_fails >= 3) { _gw.Disconnect(); Toast("Mất kết nối gateway.", true); }
        }
        UpdateChrome();
        if (_current == _dash) _dash.Tick();
        else if (_current == _devices) _devices.Tick();
    }

    void Toast(string text, bool error = false)
    {
        if (InvokeRequired) { BeginInvoke(() => Toast(text, error)); return; }
        _toast.Text = text; _toast.BackColor = error ? Theme.Red : Theme.Accent; _toast.Visible = true; _toast.BringToFront();
        PlaceToast(); _toastTimer.Stop(); _toastTimer.Start();
    }

    void PlaceToast()
    {
        _toast.Size = new Size(Math.Max(240, Math.Min(760, ClientSize.Width - 260)), 40);
        _toast.Location = new Point(_side.Width + 20, ClientSize.Height - 60);
    }

    /// <summary>Chụp cửa sổ ra file (kiểm tra giao diện, không cần chụp màn hình).</summary>
    public async Task ShotAsync(string file)
    {
        await Task.Delay(4000);
        using var bmp = new Bitmap(Width, Height);
        DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
        bmp.Save(file);
        Close();
    }
}
