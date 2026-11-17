using Plciot.Scada.Services.Ui;

namespace GatewayApp.Ui;

/// <summary>Kết quả đăng nhập: token đăng ký ngắn hạn + tài khoản đã xác thực.</summary>
public sealed record LoginResult(string Token, string User, long Uid);

/// <summary>
/// Màn hình đăng nhập lúc mở app (có thể "Bỏ qua": gateway vẫn chạy ngầm, chỉ điều khiển/sửa cấu hình mới cần).
/// Cần ĐỦ: tên đăng nhập + mật khẩu + mã ghép (OTP) tạo trên webapp bằng ĐIỆN THOẠI (Face ID / Authenticator).
/// Gateway chạy trên PC nên không mở trình duyệt ở đây.
/// </summary>
sealed class LoginForm : Form
{
    readonly string _api;
    readonly Label _status = new();
    readonly TextBox _user = new(), _pass = new() { UseSystemPasswordChar = true }, _otp = new();
    readonly FlatButton _login = new() { Caption = "Đăng nhập & kết nối", Primary = true, Width = 200 };
    readonly FlatButton _cancel = new() { Caption = "Bỏ qua", Width = 120 };
    readonly CancellationTokenSource _cts = new();

    public LoginResult? Result { get; private set; }

    public LoginForm(string api, string title = "Đăng nhập", string? reason = null)
    {
        _api = api.Trim();
        var host = Uri.TryCreate(_api, UriKind.Absolute, out var u) ? u.Host : _api;
        Text = title; ClientSize = new Size(520, 470); StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        Label L(string t, int y, int h = 22, bool bold = false) => new() { Text = t, ForeColor = bold ? Theme.Text : Theme.Muted, Font = bold ? new Font("Segoe UI Semibold", 12f) : Font, AutoSize = false, Location = new Point(24, y), Size = new Size(472, h), BackColor = Color.Transparent };
        var head = L(reason ?? "Đăng nhập tài khoản webapp", 18, 28, true);
        var l1 = L("Tên đăng nhập", 56); Skin.Input(_user); _user.Location = new Point(24, 80); _user.Width = 472;
        var l2 = L("Mật khẩu", 112); Skin.Input(_pass); _pass.Location = new Point(24, 136); _pass.Width = 472;
        var l4 = L($"Mã ghép (8 chữ số) — lấy trên ĐIỆN THOẠI: mở {host}, đăng nhập → “Kết nối gateway” → “Tạo mã ghép”, rồi gõ mã:", 168, 46);
        Skin.Input(_otp); _otp.Location = new Point(24, 220); _otp.Width = 200; _otp.MaxLength = 8;
        _otp.KeyPress += (_, e) => { if (!char.IsControl(e.KeyChar) && !char.IsDigit(e.KeyChar)) e.Handled = true; };   // mã ghép chỉ gồm chữ số
        _otp.TextChanged += (_, _) => { var d = new string(_otp.Text.Where(char.IsDigit).ToArray()); if (d != _otp.Text) { _otp.Text = d; _otp.SelectionStart = d.Length; } };   // dán chuỗi có ký tự khác → chỉ giữ số
        _login.Location = new Point(296, 216);
        _status.ForeColor = Theme.Muted; _status.AutoSize = false; _status.Location = new Point(24, 276); _status.Size = new Size(472, 60); _status.BackColor = Color.Transparent;
        var note = L("Cần đủ tên đăng nhập, mật khẩu và mã ghép. Sau khi kết nối, gateway tự gắn vào tài khoản này — không cần quét QR. Bỏ qua: gateway vẫn chạy cục bộ.", 340, 44);
        _cancel.Location = new Point(376, 420);
        _login.Click += async (_, _) => await LoginAsync();
        _otp.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await LoginAsync(); } };
        _pass.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _otp.Focus(); } };
        _user.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _pass.Focus(); } };
        _cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, l1, _user, l2, _pass, l4, _otp, _login, _status, note, _cancel });
        Shown += (_, _) => _user.Focus();
        FormClosed += (_, _) => _cts.Cancel();
    }

    HttpClient NewHttp() => new() { BaseAddress = new Uri(_api), Timeout = TimeSpan.FromSeconds(15) };

    bool Accept(LoginPoll p)
    {
        if (p.Status != "approved" || p.Token.Length == 0) return false;
        Result = new LoginResult(p.Token, p.User, p.Uid); DialogResult = DialogResult.OK; Close(); return true;
    }

    async Task LoginAsync()
    {
        var name = _user.Text.Trim(); var otp = _otp.Text.Trim();
        if (name.Length == 0 || _pass.Text.Length == 0) { _status.Text = "Nhập tên đăng nhập và mật khẩu."; return; }
        if (otp.Length == 0) { _status.Text = "Nhập mã ghép (OTP) tạo trên webapp — thiếu mã thì không đăng nhập được."; _otp.Focus(); return; }
        _login.Enabled = false;
        try
        {
            using var http = NewHttp();
            if (!Accept(await new GatewayEnrollClient(http).LoginPasswordAsync(name, _pass.Text, otp, _cts.Token))) _status.Text = "Đăng nhập không thành công.";
        }
        catch (Exception ex)
        {
            if (!IsDisposed) _status.Text = ex.Message switch
            {
                "invalid_credentials" => "Sai tên đăng nhập hoặc mật khẩu.",
                "code_required" => "Nhập mã ghép (OTP).",
                "invalid_code" => "Mã ghép sai, đã dùng, hết hạn (10 phút) hoặc không phải của tài khoản này.",
                "locked" => "Sai quá nhiều lần, khoá 15 phút.",
                "rate_limited" => "Thử quá nhanh, đợi một chút.",
                _ => "Không đăng nhập được: " + ex.Message,
            };
        }
        finally { if (!IsDisposed) { _login.Enabled = true; _pass.Clear(); _otp.Clear(); } }
    }
}
