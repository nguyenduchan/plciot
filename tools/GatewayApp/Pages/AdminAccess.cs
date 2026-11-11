using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Trang "Kết nối admin": bật/tắt cho tool admin cài đặt gateway này. Khi bật hiện mã kết nối (8 chữ số) —
/// admin nhập IP:cổng + mã vào tool. Tắt thì cổng đóng hẳn, mã cũ hết hiệu lực.
/// </summary>
sealed class AdminAccessPage : UserControl
{
    readonly ToggleSwitch _on = new() { Location = new Point(18, 54) };
    readonly ToggleSwitch _lan = new() { Location = new Point(18, 100) };
    readonly Label _lanHint = new() { ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = true, BackColor = Color.Transparent, Location = new Point(82, 125) };
    readonly Label _codeCap = new() { Text = "MÃ KẾT NỐI", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = true, BackColor = Color.Transparent, Location = new Point(18, 168) };
    readonly Label _code = new() { ForeColor = Theme.Teal, Font = new Font("Consolas", 40f, FontStyle.Bold), AutoSize = true, BackColor = Color.Transparent, Location = new Point(14, 186) };
    readonly Label _addr = new() { ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = true, BackColor = Color.Transparent, Location = new Point(18, 270) };
    readonly Label _note = new() { ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, BackColor = Color.Transparent, Location = new Point(18, 330), Size = new Size(760, 60) };
    readonly FlatButton _new = new() { Caption = "Tạo mã mới", Width = 140, Location = new Point(18, 296) };
    readonly Label _count = new() { ForeColor = Theme.Muted, Font = Theme.Normal, AutoSize = true, BackColor = Color.Transparent, Location = new Point(470, 204) };
    readonly ProgressBar _bar = new() { Location = new Point(472, 236), Size = new Size(240, 8), Minimum = 0, Maximum = 60, Style = ProgressBarStyle.Continuous };
    public event Action<bool>? EnabledChanged;
    public event Action<bool>? LanChanged;
    public event Action? NewCodeRequested;

    public AdminAccessPage()
    {
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        var card = new Card { Title = "Kết nối admin", Sub = "cho tool GatewayAdmin cài đặt thiết bị và giao thức", Dock = DockStyle.Top, Height = 410 };
        var l1 = new Label { Text = "Cho phép admin cài đặt gateway này", ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = true, BackColor = Color.Transparent, Location = new Point(82, 58) };
        var l2 = new Label { Text = "Cho phép máy khác trong mạng LAN (mặc định chỉ máy này)", ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = true, BackColor = Color.Transparent, Location = new Point(82, 104) };
        _on.Toggled += v => EnabledChanged?.Invoke(v);
        _lan.Toggled += v => LanChanged?.Invoke(v);
        _new.Click += (_, _) => NewCodeRequested?.Invoke();
        card.Controls.AddRange(new Control[] { _on, l1, _lan, l2, _lanHint, _codeCap, _code, _addr, _new, _note, _count, _bar });
        Controls.Add(card);
    }

    /// <summary>Đếm lùi đến lần đổi mã kế tiếp.</summary>
    public void SetCountdown(int sec)
    {
        sec = Math.Clamp(sec, 0, 60);
        _count.Text = $"Mã đổi sau {sec} giây";
        _count.ForeColor = sec <= 10 ? Theme.Yellow : Theme.Muted;
        _bar.Value = sec;
    }

    /// <summary>Cập nhật hiển thị theo trạng thái hiện tại (không phát sự kiện).</summary>
    public void Show(bool enabled, bool lan, string code, int port, string[] ips, bool rotating = true)
    {
        _on.On = enabled; _lan.On = lan;
        _lanHint.Text = lan ? "Tường lửa Windows có thể hỏi quyền mở cổng — chọn Cho phép." : "";
        _codeCap.Visible = _code.Visible = _addr.Visible = _new.Visible = enabled;
        _count.Visible = _bar.Visible = enabled && rotating;
        _code.Text = code.Length == 8 ? code[..4] + " " + code[4..] : code;
        _addr.Text = "Nhập vào tool admin:  " + string.Join("   hoặc   ", ips.Select(i => $"{i}:{port}"));
        _note.Text = enabled
            ? "Admin nhập địa chỉ ở trên và mã này (bỏ qua khoảng trắng). Mã tự đổi mỗi 60 giây (admin đã nối rồi thì không bị ngắt). Tắt hoặc bấm Tạo mã mới thì mọi phiên đang nối bị ngắt. Sai mã 5 lần sẽ bị khoá 1 phút."
            : "Đang TẮT: cổng đóng, tool admin không kết nối được. Bật khi cần cài đặt, xong thì tắt lại.";
        if (!enabled) _note.Location = new Point(18, 168); else _note.Location = new Point(18, 336);
    }
}
