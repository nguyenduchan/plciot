using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Đổi IP của board Waveshare (GET/PUT /api/network). Mặc định IP tĩnh 192.168.1.200/24, gateway 192.168.1.1 — như thiết bị
/// Ethernet sẵn firmware của Waveshare. Lưu xong board tự khởi động lại; trả về IP mới (rỗng = DHCP) để nối lại.
/// </summary>
sealed class NetworkDialog : Form
{
    readonly RemoteClient _client;
    readonly CheckBox _dhcp = new() { Text = "Lấy IP tự động (DHCP)", AutoSize = true, ForeColor = Theme.Text };
    readonly TextBox _ip = new() { Width = 180 }, _mask = new() { Width = 180 }, _gw = new() { Width = 180 }, _dns = new() { Width = 180, PlaceholderText = "Tự động (theo mạng)" };
    /// <summary>Đường ra Internet khi board có cả dây và Wi-Fi (firmware ≥ mcu-0.4.17). Thứ tự = PrefValues.</summary>
    readonly ComboBox _pref = new() { Width = 290, DropDownStyle = ComboBoxStyle.DropDownList };
    static readonly string[] PrefValues = { "auto", "wifi", "eth" };
    readonly bool _hasPref;
    readonly Label _msg = new() { AutoSize = false, Dock = DockStyle.Bottom, Height = 52, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(14, 4, 14, 0) };
    readonly FlatButton _save = new() { Caption = "Lưu & khởi động lại", Primary = true, Width = 190 };
    public string? NewHost { get; private set; }

    NetworkDialog(RemoteClient client, ApiNetwork cur)
    {
        _client = client;
        Text = "Mạng của board Waveshare"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        _hasPref = cur.Pref.Length > 0;   // firmware cũ không báo Pref → không có ô chọn
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(480, _hasPref ? 400 : 330);
        var info = new Label { Dock = DockStyle.Top, Height = 48, ForeColor = Theme.Muted, Padding = new Padding(14, 10, 14, 0), UseMnemonic = false,
            Text = $"MAC {cur.Mac} · đang dùng {cur.Current}. Mặc định của board: 192.168.1.200 / 255.255.255.0, gateway 192.168.1.1." };
        var grid = new TableLayoutPanel { Dock = DockStyle.Top, Height = _hasPref ? 250 : 180, ColumnCount = 2, Padding = new Padding(14, 4, 14, 0), BackColor = Theme.Bg };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Row(string label, Control c) { grid.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 8, 0, 0) }); grid.Controls.Add(c); }
        grid.Controls.Add(_dhcp); grid.SetColumnSpan(_dhcp, 2);
        Row("Địa chỉ IP", _ip); Row("Subnet mask", _mask); Row("Gateway", _gw); Row("DNS", _dns);
        _dhcp.Checked = cur.Dhcp; _ip.Text = cur.Ip; _mask.Text = cur.Mask; _gw.Text = cur.Gateway; _dns.Text = cur.Dns;
        if (_hasPref)
        {
            _pref.Items.AddRange(new object[] { "Tự động — Wi-Fi; dùng dây khi dây ra được Internet", "Luôn Wi-Fi (dây chỉ dùng trong LAN)", "Luôn Ethernet (dây)" });
            _pref.SelectedIndex = Math.Max(0, Array.IndexOf(PrefValues, cur.Pref));
            Row("Đường Internet", _pref);
            var hint = new Label { AutoSize = true, MaximumSize = new Size(300, 0), ForeColor = Theme.Muted, Font = Theme.Small, Margin = new Padding(3, 2, 0, 0),
                Text = "Khi có cả dây và Wi-Fi. Dây cắm thẳng PC (không Internet) → chọn Tự động hoặc Luôn Wi-Fi." };
            grid.Controls.Add(new Label()); grid.Controls.Add(hint);
        }
        _dhcp.CheckedChanged += (_, _) => Sync(); Sync();
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg };
        var def = new FlatButton { Caption = "Mặc định", Width = 100 };
        def.Click += (_, _) => { _dhcp.Checked = false; _ip.Text = "192.168.1.200"; _mask.Text = "255.255.255.0"; _gw.Text = "192.168.1.1"; _dns.Text = ""; if (_hasPref) _pref.SelectedIndex = 0; };   // DNS trống = theo mạng (không ép 8.8.8.8 — nhiều mạng chặn)
        var cancel = new FlatButton { Caption = "Huỷ", Width = 90 };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        _save.Click += async (_, _) => await SaveAsync();
        bar.Controls.AddRange(new Control[] { _save, def, cancel });
        Controls.Add(grid); Controls.Add(_msg); Controls.Add(bar); Controls.Add(info);
    }

    void Sync() { foreach (var t in new[] { _ip, _mask, _gw, _dns }) t.Enabled = !_dhcp.Checked; }

    async Task SaveAsync()
    {
        var n = new ApiNetwork { Dhcp = _dhcp.Checked, Ip = _ip.Text.Trim(), Mask = _mask.Text.Trim(), Gateway = _gw.Text.Trim(), Dns = _dns.Text.Trim(),
            Pref = _hasPref ? PrefValues[Math.Max(0, _pref.SelectedIndex)] : "" };
        if (!n.Dhcp && !RemoteClient.SameSubnetAsThisPc(n.Ip)
            && !Ask.Yes(this, $"IP {n.Ip} KHÁC mạng con với PC này: sau khi board khởi động lại, PC sẽ không nối tới được (vẫn thấy trong danh sách tìm thiết bị).\n\nVẫn lưu?", "Khác mạng con"))
            return;
        _save.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = "Đang lưu…";
        try
        {
            var r = await _client.PutNetworkAsync(n);
            if (!r.Ok) { _msg.ForeColor = Theme.Red; _msg.Text = r.Err ?? "Lỗi."; return; }
            NewHost = n.Dhcp ? "" : n.Ip;
            DialogResult = DialogResult.OK; Close();
        }
        catch (Exception e) { _msg.ForeColor = Theme.Red; _msg.Text = RemoteClient.Explain(e); }
        finally { if (!IsDisposed) _save.Enabled = true; }
    }

    /// <summary>null = huỷ; "" = đã chuyển DHCP (tìm lại board trong danh sách); còn lại = IP tĩnh mới.</summary>
    public static async Task<string?> RunAsync(IWin32Window owner, RemoteClient client)
    {
        ApiNetwork cur;
        try { cur = await client.NetworkAsync(); }
        catch (Exception e) { MessageBox.Show(owner, RemoteClient.Explain(e), "Mạng của board", MessageBoxButtons.OK, MessageBoxIcon.Warning); return null; }
        using var d = new NetworkDialog(client, cur);
        return d.ShowDialog(owner) == DialogResult.OK ? d.NewHost : null;
    }
}
