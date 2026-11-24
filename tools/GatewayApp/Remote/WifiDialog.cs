using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Wi-Fi của board Waveshare, kiểu màn hình nối Wi-Fi của các thiết bị IoT thông dụng: mạng đang nối ở trên cùng (vạch sóng, IP),
/// danh sách mạng quanh board (vạch sóng + ổ khoá, mạnh trước), bấm một mạng → ô mật khẩu có nút hiện/ẩn → Kết nối;
/// "Mạng khác…" cho tên Wi-Fi ẩn; Quên mạng; Quét lại. Mật khẩu chỉ đi lên board (HTTPS đã ghim khoá), board không bao giờ trả lại.
/// Nối xong có IP Wi-Fi: GatewayApp cài đặt board qua Wi-Fi giống hệt khi cắm dây (cùng HTTPS 443, cùng tìm thiết bị UDP).
/// </summary>
sealed class WifiDialog : Form
{
    sealed record Row(string Ssid, int Rssi, bool Open, bool Other, bool Current);

    readonly RemoteClient _client;
    readonly Label _head = new() { Dock = DockStyle.Top, Height = 74, ForeColor = Theme.Text, Font = Theme.Semi, Padding = new Padding(16, 12, 16, 0), UseMnemonic = false };
    readonly ListBox _list = new() { Dock = DockStyle.Fill, DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 46, BorderStyle = BorderStyle.None, BackColor = Theme.Panel, IntegralHeight = false };
    readonly Panel _pw = new() { Dock = DockStyle.Bottom, Height = 132, BackColor = Theme.Panel2, Visible = false, Padding = new Padding(16, 10, 16, 6) };
    readonly Label _pwTitle = new() { AutoSize = true, ForeColor = Theme.Text, Font = Theme.Semi, UseMnemonic = false, Location = new Point(16, 10) };
    readonly TextBox _ssid = new() { Width = 300, Location = new Point(16, 38), Visible = false };
    readonly TextBox _pass = new() { Width = 300, Location = new Point(16, 38), UseSystemPasswordChar = true };
    readonly CheckBox _show = new() { Text = "Hiện mật khẩu", AutoSize = true, ForeColor = Theme.Muted, Location = new Point(330, 40) };
    readonly FlatButton _go = new() { Caption = "Kết nối", Primary = true, Width = 130, Location = new Point(16, 84) };
    readonly FlatButton _cancel = new() { Caption = "Huỷ", Width = 90, Location = new Point(156, 84) };
    readonly Label _msg = new() { Dock = DockStyle.Bottom, Height = 44, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(16, 6, 16, 0), UseMnemonic = false };
    readonly FlatButton _scan = new() { Caption = "Quét lại", Width = 110 }, _forget = new() { Caption = "Quên mạng", Danger = true, Width = 120, Visible = false },
        _viaWifi = new() { Caption = "Nối lại qua Wi-Fi", Primary = true, Width = 160, Visible = false }, _close = new() { Caption = "Đóng", Width = 90 };
    ApiWifi _st = new();
    bool _busy;
    /// <summary>IP Wi-Fi của board nếu người dùng chọn "Nối lại qua Wi-Fi"; null = không.</summary>
    public string? ReconnectHost { get; private set; }
    /// <summary>IP Wi-Fi của board sau lần nối thành công gần nhất (kể cả khi người dùng không bấm "Nối lại qua Wi-Fi").</summary>
    public string? LastIp { get; private set; }

    WifiDialog(RemoteClient client)
    {
        _client = client;
        Text = "Wi-Fi của board Waveshare"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(520, 640);

        _pw.Controls.AddRange(new Control[] { _pwTitle, _ssid, _pass, _show, _go, _cancel });
        _show.CheckedChanged += (_, _) => _pass.UseSystemPasswordChar = !_show.Checked;
        _cancel.Click += (_, _) => { _pw.Visible = false; _list.ClearSelected(); };
        _go.Click += async (_, _) => await ConnectAsync();
        _pass.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await ConnectAsync(); } };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg, FlowDirection = FlowDirection.RightToLeft };
        bar.Controls.AddRange(new Control[] { _close, _viaWifi, _forget, _scan });
        _close.Click += (_, _) => { if (!_busy) { DialogResult = ReconnectHost != null ? DialogResult.OK : DialogResult.Cancel; Close(); } };
        _scan.Click += async (_, _) => await ReloadAsync();
        _forget.Click += async (_, _) => await ForgetAsync();
        _viaWifi.Click += (_, _) => { if (_st.Connected && _st.Ip.Length > 0) { ReconnectHost = _st.Ip; DialogResult = DialogResult.OK; Close(); } };

        _list.DrawItem += DrawRow;
        _list.SelectedIndexChanged += (_, _) => Pick();
        FormClosing += (_, e) => { if (_busy) e.Cancel = true; };
        var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 0, 0, 0), BackColor = Theme.Panel }; host.Controls.Add(_list);
        Controls.Add(host); Controls.Add(_pw); Controls.Add(_msg); Controls.Add(bar); Controls.Add(_head);
        Shown += async (_, _) => await ReloadAsync();
    }

    static string Bars(int rssi) => rssi >= -55 ? "Mạnh" : rssi >= -67 ? "Khá" : rssi >= -78 ? "Trung bình" : "Yếu";
    static int Level(int rssi) => rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -78 ? 2 : 1;

    void DrawRow(object? s, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= _list.Items.Count) return;
        var r = (Row)_list.Items[e.Index];
        var sel = (e.State & DrawItemState.Selected) != 0;
        using (var bg = new SolidBrush(sel ? Theme.Mix(Theme.Panel2, Theme.Accent, 0.35) : Theme.Panel)) e.Graphics.FillRectangle(bg, e.Bounds);
        using (var ln = new Pen(Theme.Border)) e.Graphics.DrawLine(ln, e.Bounds.Left + 16, e.Bounds.Bottom - 1, e.Bounds.Right - 16, e.Bounds.Bottom - 1);
        Theme.Quality(e.Graphics);
        if (r.Other)
        {
            TextRenderer.DrawText(e.Graphics, "＋  Mạng khác… (tên Wi-Fi ẩn)", Theme.Normal, new Rectangle(e.Bounds.X + 16, e.Bounds.Y, e.Bounds.Width - 32, e.Bounds.Height), Theme.Accent, TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
            return;
        }
        var name = (r.Current ? "✓  " : "") + r.Ssid;
        TextRenderer.DrawText(e.Graphics, name, Theme.Semi, new Rectangle(e.Bounds.X + 16, e.Bounds.Y + 5, e.Bounds.Width - 120, 20), r.Current ? Theme.Green : Theme.Text, TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        var sub = (r.Current ? "Đã kết nối · " : "") + (r.Open ? "Mở" : "Bảo mật") + " · " + Bars(r.Rssi) + $" ({r.Rssi} dBm)";
        TextRenderer.DrawText(e.Graphics, sub, Theme.Small, new Rectangle(e.Bounds.X + 16, e.Bounds.Y + 25, e.Bounds.Width - 120, 16), Theme.Muted, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        // vạch sóng bên phải + ổ khoá
        var lvl = Level(r.Rssi); var x0 = e.Bounds.Right - 62; var yb = e.Bounds.Y + 31;
        for (var i = 0; i < 4; i++)
        {
            using var b = new SolidBrush(i < lvl ? (r.Current ? Theme.Green : Theme.Text) : Theme.Border);
            e.Graphics.FillRectangle(b, x0 + i * 7, yb - 5 - i * 4, 5, 5 + i * 4);
        }
        if (!r.Open) TextRenderer.DrawText(e.Graphics, "🔒", Theme.Small, new Rectangle(x0 - 26, e.Bounds.Y, 24, e.Bounds.Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
    }

    void Msg(string t, bool err = false) { _msg.ForeColor = err ? Theme.Red : Theme.Muted; _msg.Text = t; }

    void Busy(bool on)
    {
        _busy = on; _go.Enabled = _scan.Enabled = _forget.Enabled = _close.Enabled = _cancel.Enabled = _viaWifi.Enabled = !on; _list.Enabled = !on;
    }

    void Header()
    {
        if (!_st.Supported) { _head.Text = "Thiết bị này không có Wi-Fi."; return; }
        if (_st.Connected)
            _head.Text = $"✓  Đang nối: {_st.Ssid}\r\nIP {_st.Ip}  ·  sóng {Bars(_st.Rssi)} ({_st.Rssi} dBm)\r\nCài đặt board qua Wi-Fi giống khi cắm dây.";
        else if (_st.Saved.Length > 0)
            _head.Text = $"Đã lưu \"{_st.Saved}\" nhưng chưa nối được (ngoài tầm sóng hoặc đang nối lại).\r\nQuét lại để thử, hoặc chọn mạng khác bên dưới.";
        else
            _head.Text = "Chưa nối Wi-Fi.\r\nChọn mạng bên dưới để nối. Ethernet vẫn dùng bình thường.";
        _forget.Visible = _st.Saved.Length > 0;
        _viaWifi.Visible = _st.Connected && _st.Ip.Length > 0 && !_client.Address.StartsWith(_st.Ip + ":");
    }

    async Task ReloadAsync()
    {
        if (_busy) return;
        Busy(true); Msg("Đang quét Wi-Fi quanh board… (khoảng 3–5 giây)");
        try
        {
            _st = await _client.WifiAsync(); Header();
            var nets = await _client.WifiScanAsync();
            _st = await _client.WifiAsync(); Header();
            _list.BeginUpdate(); _list.Items.Clear();
            foreach (var n in nets.OrderByDescending(n => n.Ssid == _st.Ssid && _st.Connected).ThenByDescending(n => n.Rssi))
                _list.Items.Add(new Row(n.Ssid, n.Rssi, n.Open, false, _st.Connected && n.Ssid == _st.Ssid));
            _list.Items.Add(new Row("", 0, false, true, false));
            _list.EndUpdate();
            Msg(nets.Count == 0
                ? "Không thấy mạng Wi-Fi nào. Board dùng module WROOM-1U (ăng-ten ngoài): kiểm tra đã gắn ăng-ten vào đầu U.FL chưa, rồi Quét lại."
                : $"Thấy {nets.Count} mạng. Chọn mạng để nối.");
        }
        catch (Exception e) { Msg(RemoteClient.Explain(e), true); }
        finally { Busy(false); }
    }

    void Pick()
    {
        if (_busy || _list.SelectedItem is not Row r) return;
        _pw.Visible = true; _pass.Text = ""; _show.Checked = false;
        if (r.Other)
        {
            _pwTitle.Text = "Nối mạng Wi-Fi ẩn / nhập tên"; _ssid.Visible = true; _ssid.Text = ""; _pass.Location = new Point(16, 68); _show.Location = new Point(330, 70);
            _go.Location = new Point(16, 98); _cancel.Location = new Point(156, 98); _pw.Height = 146; _ssid.Focus();
        }
        else
        {
            _ssid.Visible = false; _pass.Location = new Point(16, 38); _show.Location = new Point(330, 40); _go.Location = new Point(16, 84); _cancel.Location = new Point(156, 84); _pw.Height = 132;
            _pwTitle.Text = r.Open ? $"Nối \"{r.Ssid}\" (mạng mở, không cần mật khẩu)" : $"Mật khẩu cho \"{r.Ssid}\"";
            _pass.Visible = _show.Visible = !r.Open;
            if (!r.Open) _pass.Focus();
        }
    }

    async Task ConnectAsync()
    {
        if (_busy || _list.SelectedItem is not Row r) return;
        var ssid = r.Other ? _ssid.Text.Trim() : r.Ssid;
        if (ssid.Length == 0) { Msg("Nhập tên Wi-Fi (SSID).", true); return; }
        Busy(true); Msg($"Đang nối \"{ssid}\"… (tối đa 15 giây)");
        try
        {
            _st = await _client.PutWifiAsync(ssid, r.Open && !r.Other ? "" : _pass.Text);
            _pass.Text = ""; _pw.Visible = false; LastIp = _st.Ip;
            Header();
            Msg($"Đã nối \"{_st.Ssid}\" — IP {_st.Ip}. Rút dây Ethernet được: bấm \"Nối lại qua Wi-Fi\" để tiếp tục cài đặt bằng Wi-Fi.");
        }
        catch (Exception e) { Msg(RemoteClient.Explain(e), true); }
        finally { Busy(false); }
        await ReloadAsync();
    }

    async Task ForgetAsync()
    {
        if (_busy || !Ask.Yes(this, $"Quên Wi-Fi \"{_st.Saved}\"? Board sẽ không tự nối mạng này nữa (Ethernet không ảnh hưởng).", "Quên mạng Wi-Fi")) return;
        Busy(true);
        try { _st = await _client.PutWifiAsync("", ""); Header(); Msg("Đã quên mạng đã lưu."); }
        catch (Exception e) { Msg(RemoteClient.Explain(e), true); }
        finally { Busy(false); }
        await ReloadAsync();
    }

    /// <summary>Dùng khi cài đặt lần đầu qua hotspot: trả IP Wi-Fi của board nếu đã nối được (dù người dùng chỉ bấm Đóng), null nếu chưa nối.</summary>
    public static string? RunSetup(IWin32Window owner, RemoteClient client)
    {
        using var d = new WifiDialog(client);
        d.ShowDialog(owner);
        return d.ReconnectHost ?? d.LastIp;
    }

    /// <summary>IP Wi-Fi để nối lại (người dùng bấm "Nối lại qua Wi-Fi") hoặc null.</summary>
    public static string? Run(IWin32Window owner, RemoteClient client)
    {
        using var d = new WifiDialog(client);
        d.ShowDialog(owner);
        return d.ReconnectHost;
    }
}
