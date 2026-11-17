using Plciot.Scada;

namespace GatewayApp.Ui;

/// <summary>
/// Mật khẩu CỤC BỘ của gateway: mở khoá sửa cấu hình/điều khiển tại máy mà không cần webapp hay Internet.
/// Đặt (hai ô nhập lại) hoặc nhập để mở khoá. "Dùng webapp" (Retry) = người dùng chọn xác nhận bằng OTP/Authenticator qua webapp
/// (cũng là cách ĐẶT LẠI mật khẩu khi quên: chủ tài khoản đã xác thực thì được đặt mật khẩu mới).
/// </summary>
sealed class LocalPasswordForm : Form
{
    readonly bool _set;
    readonly string _stored;
    readonly TextBox _p1 = new() { UseSystemPasswordChar = true }, _p2 = new() { UseSystemPasswordChar = true };
    readonly Label _status = new();
    int _fails;

    /// <summary>Mật khẩu vừa đặt (chế độ đặt).</summary>
    public string? NewHash { get; private set; }

    LocalPasswordForm(bool set, string stored, string title, string reason, bool offerWebapp)
    {
        _set = set; _stored = stored;
        Text = title; ClientSize = new Size(480, set ? 330 : 270); StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        Label L(string t, int y, int h = 22, bool bold = false) => new() { Text = t, ForeColor = bold ? Theme.Text : Theme.Muted, Font = bold ? new Font("Segoe UI Semibold", 12f) : Font, AutoSize = false, Location = new Point(24, y), Size = new Size(432, h), BackColor = Color.Transparent };
        var head = L(reason, 18, 44, true);
        var l1 = L(set ? $"Mật khẩu mới (tối thiểu {LocalPassword.MinLength} ký tự)" : "Mật khẩu gateway", 70);
        Skin.Input(_p1); _p1.Location = new Point(24, 94); _p1.Width = 432;
        var ctrls = new List<Control> { head, l1, _p1 };
        var y = 140;
        if (set)
        {
            ctrls.Add(L("Nhập lại", y)); Skin.Input(_p2); _p2.Location = new Point(24, y + 24); _p2.Width = 432; ctrls.Add(_p2); y += 76;
        }
        _status.ForeColor = Theme.Muted; _status.AutoSize = false; _status.BackColor = Color.Transparent; _status.Location = new Point(24, y); _status.Size = new Size(432, 44);
        ctrls.Add(_status);
        var ok = new FlatButton { Caption = set ? "Đặt mật khẩu" : "Mở khoá", Primary = true, Width = 150, Location = new Point(306, ClientSize.Height - 56) };
        var cancel = new FlatButton { Caption = "Bỏ qua", Width = 110, Location = new Point(186, ClientSize.Height - 56) };
        ok.Click += (_, _) => Submit();
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        ctrls.Add(ok); ctrls.Add(cancel);
        if (offerWebapp)
        {
            var web = new FlatButton { Caption = "Quên / dùng webapp", Width = 150, Location = new Point(24, ClientSize.Height - 56) };
            web.Click += (_, _) => { DialogResult = DialogResult.Retry; Close(); };
            ctrls.Add(web);
        }
        _p1.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; if (set) _p2.Focus(); else Submit(); } };
        _p2.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Submit(); } };
        Controls.AddRange(ctrls.ToArray());
        Shown += (_, _) => _p1.Focus();
    }

    void Submit()
    {
        if (_set)
        {
            if (_p1.Text.Length < LocalPassword.MinLength) { _status.Text = $"Mật khẩu tối thiểu {LocalPassword.MinLength} ký tự."; return; }
            if (_p1.Text != _p2.Text) { _status.Text = "Hai lần nhập không khớp."; return; }
            NewHash = LocalPassword.Create(_p1.Text);
            DialogResult = DialogResult.OK; Close(); return;
        }
        if (LocalPassword.Verify(_p1.Text, _stored)) { DialogResult = DialogResult.OK; Close(); return; }
        _fails++; _p1.Clear();
        _status.Text = _fails >= 5 ? "Sai nhiều lần. Dùng “Quên / dùng webapp” để xác nhận bằng OTP và đặt lại." : "Sai mật khẩu.";
    }

    /// <summary>Mở khoá bằng mật khẩu đã đặt. OK = đúng; Retry = chọn dùng webapp; Cancel = bỏ qua.</summary>
    public static DialogResult Unlock(IWin32Window owner, string stored, string reason)
    {
        using var f = new LocalPasswordForm(false, stored, "Mở khoá gateway", reason, true);
        return f.ShowDialog(owner);
    }

    /// <summary>Đặt mật khẩu mới; trả về băm hoặc null nếu bỏ qua.</summary>
    public static string? Create(IWin32Window owner, string reason)
    {
        using var f = new LocalPasswordForm(true, "", "Đặt mật khẩu gateway", reason, false);
        return f.ShowDialog(owner) == DialogResult.OK ? f.NewHash : null;
    }
}

/// <summary>Chọn gateway cũ của tài khoản để chuyển sang PC này.</summary>
sealed class GatewayPickerForm : Form
{
    readonly ListBox _list = new() { BorderStyle = BorderStyle.FixedSingle };
    readonly List<(string Site, string Device, string Label)> _items;
    public (string Site, string Device)? Picked { get; private set; }

    GatewayPickerForm(List<(string Site, string Device, string Label)> items)
    {
        _items = items;
        Text = "Chuyển gateway sang PC này"; ClientSize = new Size(480, 340); StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        var head = new Label { Text = "Chọn gateway cũ để chuyển sang PC này. QR, thiết bị và lịch sử được giữ nguyên; PC cũ sẽ bị ngắt kết nối.", ForeColor = Theme.Muted, AutoSize = false, Location = new Point(24, 18), Size = new Size(432, 52), BackColor = Color.Transparent };
        _list.Location = new Point(24, 80); _list.Size = new Size(432, 190); _list.BackColor = Theme.Panel; _list.ForeColor = Theme.Text;
        foreach (var i in items) _list.Items.Add($"{(i.Label.Length > 0 ? i.Label + "  ·  " : "")}{i.Site}/{i.Device}");
        if (items.Count > 0) _list.SelectedIndex = 0;
        var ok = new FlatButton { Caption = "Chuyển sang PC này", Primary = true, Width = 200, Location = new Point(256, 284) };
        var cancel = new FlatButton { Caption = "Huỷ", Width = 110, Location = new Point(136, 284) };
        ok.Click += (_, _) => { if (_list.SelectedIndex >= 0) { var i = _items[_list.SelectedIndex]; Picked = (i.Site, i.Device); DialogResult = DialogResult.OK; Close(); } };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, _list, ok, cancel });
    }

    public static (string Site, string Device)? Pick(IWin32Window owner, List<(string Site, string Device, string Label)> items)
    {
        using var f = new GatewayPickerForm(items);
        return f.ShowDialog(owner) == DialogResult.OK ? f.Picked : null;
    }
}
