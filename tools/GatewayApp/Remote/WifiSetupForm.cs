using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// BƯỚC 1 của cài Wi-Fi cho board mới: nhập TRƯỚC tên Wi-Fi + mật khẩu (PC còn mạng, board chưa cần nối). Gợi ý sẵn mạng PC đang dùng
/// và các mạng đã lưu. Sau khi bấm Bắt đầu, GatewayApp tự làm hết (USB hoặc hotspot) và tự đưa PC về mạng cũ — không phải nhập thêm gì.
/// </summary>
sealed class WifiSetupForm : Form
{
    readonly ComboBox _ssid = new() { DropDownStyle = ComboBoxStyle.DropDown, Width = 360 };
    readonly TextBox _pass = new() { Width = 360, UseSystemPasswordChar = true };
    readonly CheckBox _show = new() { Text = "Hiện mật khẩu", AutoSize = true, ForeColor = Theme.Muted };
    readonly Label _err = new() { AutoSize = true, ForeColor = Theme.Red, Font = Theme.Small };
    public string Ssid => _ssid.Text.Trim();
    public string Password => _pass.Text;

    WifiSetupForm(string ssid, string pass, string error)
    {
        Text = "Cài Wi-Fi cho board Waveshare"; StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; TopMost = true;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(460, 330);
        var info = new Label { Location = new Point(20, 14), Size = new Size(420, 76), ForeColor = Theme.Muted, UseMnemonic = false,
            Text = "Nhập Wi-Fi mà board sẽ dùng (cùng mạng với PC này). GatewayApp tự cài cho board qua cáp USB nếu có, nếu không thì qua hotspot của board rồi tự đưa PC về lại mạng hiện tại. Board chỉ dùng Wi-Fi 2.4 GHz." };
        var l1 = new Label { Text = "Tên Wi-Fi (SSID)", Location = new Point(20, 100), AutoSize = true, ForeColor = Theme.Muted };
        _ssid.Location = new Point(20, 122);
        var cur = PcWifi.CurrentSsid();
        foreach (var s in new[] { cur }.Concat(PcWifi.SavedProfiles()).Where(s => s.Length > 0).Distinct()) _ssid.Items.Add(s);
        if (cur.Length > 0) _ssid.Text = cur;
        if (ssid.Length > 0) { _ssid.Text = ssid; _pass.Text = pass; }
        var l2 = new Label { Text = "Mật khẩu Wi-Fi", Location = new Point(20, 164), AutoSize = true, ForeColor = Theme.Muted };
        _pass.Location = new Point(20, 186); _show.Location = new Point(20, 216);
        _show.CheckedChanged += (_, _) => _pass.UseSystemPasswordChar = !_show.Checked;
        _err.Location = new Point(20, 244); _err.MaximumSize = new Size(420, 30); _err.Text = error;
        Shown += (_, _) => { Activate(); if (error.Length > 0) { _pass.Focus(); _pass.SelectAll(); } };
        var go = new FlatButton { Caption = "Bắt đầu cài", Primary = true, Width = 150, Location = new Point(20, 276) };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 90, Location = new Point(180, 276) };
        go.Click += (_, _) => Submit();
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        _pass.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Submit(); } };
        Controls.AddRange(new Control[] { info, l1, _ssid, l2, _pass, _show, _err, go, cancel });
    }

    void Submit()
    {
        if (Ssid.Length == 0) { _err.Text = "Nhập tên Wi-Fi."; return; }
        if (Ssid.Length > 32) { _err.Text = "Tên Wi-Fi tối đa 32 ký tự."; return; }
        if (Password.Length != 0 && (Password.Length < 8 || Password.Length > 63)) { _err.Text = "Mật khẩu Wi-Fi phải từ 8 đến 63 ký tự (hoặc để trống nếu mạng mở)."; return; }
        DialogResult = DialogResult.OK; Close();
    }

    /// <summary>null = huỷ.</summary>
    public static (string Ssid, string Password)? Ask(IWin32Window? owner, string ssid = "", string pass = "", string error = "")
    {
        using var f = new WifiSetupForm(ssid, pass, error);
        return f.ShowDialog(owner) == DialogResult.OK ? (f.Ssid, f.Password) : null;
    }
}
