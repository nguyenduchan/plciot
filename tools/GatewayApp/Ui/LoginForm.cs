using Plciot.Scada.Services.Ui;

namespace GatewayApp.Ui;

/// <summary>Kết quả đăng nhập: token đăng ký ngắn hạn + tài khoản đã xác thực.</summary>
public sealed record LoginResult(string Token, string User, long Uid);

/// <summary>
/// Màn hình đăng nhập lúc mở app (có thể "Bỏ qua": gateway vẫn chạy ngầm, chỉ điều khiển/sửa cấu hình mới cần).
/// Cách 1: tên đăng nhập + mật khẩu + mã Authenticator (mật khẩu một mình KHÔNG đủ — server từ chối nếu thiếu mã).
/// Cách 2: mã ghép (OTP) tạo trên webapp bằng ĐIỆN THOẠI (Face ID / Authenticator), gõ vào đây — không cần gõ mật khẩu trên PC.
/// Gateway chạy trên PC nên không mở trình duyệt ở đây.
/// </summary>
sealed class LoginForm : Form
{
    readonly string _api;
    readonly Label _status = new();
    readonly TextBox _user = new(), _pass = new() { UseSystemPasswordChar = true }, _totp = new(), _otp = new();
    readonly FlatButton _login = new() { Caption = "Đăng nhập", Primary = true, Width = 160 };
    readonly FlatButton _otpGo = new() { Caption = "Dùng mã ghép", Width = 160 };
    readonly FlatButton _cancel = new() { Caption = "Bỏ qua", Width = 120 };
    readonly CancellationTokenSource _cts = new();

    public LoginResult? Result { get; private set; }

    public LoginForm(string api, string title = "Đăng nhập", string? reason = null)
    {
        _api = api.Trim();
        var host = Uri.TryCreate(_api, UriKind.Absolute, out var u) ? u.Host : _api;
        Text = title; ClientSize = new Size(520, 560); StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        Label L(string t, int y, int h = 22, bool bold = false) => new() { Text = t, ForeColor = bold ? Theme.Text : Theme.Muted, Font = bold ? new Font("Segoe UI Semibold", 12f) : Font, AutoSize = false, Location = new Point(24, y), Size = new Size(472, h), BackColor = Color.Transparent };
        var head = L(reason ?? "Đăng nhập tài khoản webapp", 18, 28, true);
        var l1 = L("Tên đăng nhập", 56); Skin.Input(_user); _user.Location = new Point(24, 80); _user.Width = 472;
        var l2 = L("Mật khẩu", 112); Skin.Input(_pass); _pass.Location = new Point(24, 136); _pass.Width = 472;
        var l3 = L("Mã Authenticator (6 số) — bắt buộc, chỉ mật khẩu là không đủ", 168); Skin.Input(_totp); _totp.Location = new Point(24, 192); _totp.Width = 200; _totp.MaxLength = 8;
        _login.Location = new Point(336, 188);
        var l4 = L($"Hoặc lấy mã ghép (OTP) trên ĐIỆN THOẠI: mở {host}, đăng nhập (Face ID / Authenticator) → “Kết nối gateway” → “Tạo mã ghép”, rồi gõ mã:", 248, 46);
        Skin.Input(_otp); _otp.Location = new Point(24, 302); _otp.Width = 200; _otp.CharacterCasing = CharacterCasing.Upper; _otp.MaxLength = 9;
        _otpGo.Location = new Point(336, 298);
        _status.ForeColor = Theme.Muted; _status.AutoSize = false; _status.Location = new Point(24, 356); _status.Size = new Size(472, 60); _status.BackColor = Color.Transparent;
        var note = L("Bỏ qua: gateway vẫn chạy ngầm và nối server; khi điều khiển hoặc sửa cấu hình sẽ hỏi lại. Đóng rồi mở lại app phải đăng nhập lại.", 424, 44);
        _cancel.Location = new Point(376, 500);
        _login.Click += async (_, _) => await PasswordAsync();
        _otpGo.Click += async (_, _) => await RedeemAsync();
        _totp.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await PasswordAsync(); } };
        _pass.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _totp.Focus(); } };
        _user.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _pass.Focus(); } };
        _otp.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await RedeemAsync(); } };
        _cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, l1, _user, l2, _pass, l3, _totp, _login, l4, _otp, _otpGo, _status, note, _cancel });
        Shown += (_, _) => _user.Focus();
        FormClosed += (_, _) => _cts.Cancel();
    }

    HttpClient NewHttp() => new() { BaseAddress = new Uri(_api), Timeout = TimeSpan.FromSeconds(15) };

    bool Accept(LoginPoll p)
    {
        if (p.Status != "approved" || p.Token.Length == 0) return false;
        Result = new LoginResult(p.Token, p.User, p.Uid); DialogResult = DialogResult.OK; Close(); return true;
    }

    async Task PasswordAsync()
    {
        var name = _user.Text.Trim();
        if (name.Length == 0 || _pass.Text.Length == 0) { _status.Text = "Nhập tên đăng nhập và mật khẩu."; return; }
        if (_totp.Text.Trim().Length == 0) { _status.Text = "Nhập mã Authenticator — chỉ mật khẩu là không đủ."; _totp.Focus(); return; }
        _login.Enabled = false;
        try
        {
            using var http = NewHttp();
            if (!Accept(await new GatewayEnrollClient(http).LoginPasswordAsync(name, _pass.Text, _totp.Text.Trim(), _cts.Token))) _status.Text = "Đăng nhập không thành công.";
        }
        catch (Exception ex)
        {
            if (!IsDisposed) _status.Text = ex.Message switch
            {
                "invalid_credentials" => "Sai tên đăng nhập hoặc mật khẩu.",
                "totp_required" => "Nhập mã Authenticator.",
                "totp_invalid" => "Mã Authenticator sai hoặc đã dùng — đợi mã mới rồi thử lại.",
                "totp_not_enabled" => "Tài khoản chưa bật Authenticator: bật trong Cài đặt webapp, hoặc dùng mã ghép bên dưới.",
                "locked" => "Sai quá nhiều lần, khoá 15 phút.",
                "rate_limited" => "Thử quá nhanh, đợi một chút.",
                _ => "Không đăng nhập được: " + ex.Message,
            };
        }
        finally { if (!IsDisposed) { _login.Enabled = true; _pass.Clear(); } }
    }

    async Task RedeemAsync()
    {
        var otp = _otp.Text.Trim();
        if (otp.Length == 0) { _status.Text = "Nhập mã ghép (OTP) tạo trên webapp."; return; }
        _otpGo.Enabled = false;
        try
        {
            using var http = NewHttp();
            if (!Accept(await new GatewayEnrollClient(http).LoginRedeemAsync(otp, _cts.Token))) _status.Text = "Mã ghép không hợp lệ.";
        }
        catch (Exception ex) { if (!IsDisposed) _status.Text = ex.Message is "invalid_code" or "invalid_login" ? "Mã sai, đã dùng hoặc hết hạn (10 phút)." : ex.Message == "rate_limited" ? "Thử quá nhanh, đợi một chút." : "Không dùng được mã: " + ex.Message; }
        finally { if (!IsDisposed) _otpGo.Enabled = true; }
    }
}
