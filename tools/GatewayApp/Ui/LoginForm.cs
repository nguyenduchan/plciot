using System.Diagnostics;
using Plciot.Scada.Services.Ui;

namespace GatewayApp.Ui;

/// <summary>Kết quả đăng nhập qua trình duyệt: token đăng ký ngắn hạn + tài khoản đã duyệt.</summary>
public sealed record LoginResult(string Token, string User, long Uid);

/// <summary>
/// Màn hình đăng nhập: app KHÔNG nhận mật khẩu. Hiện mã ngắn + mở trang webapp; người dùng đăng nhập trên webapp
/// (Face ID / TOTP như thường) và bấm Duyệt. App hỏi server mỗi vài giây cho tới khi được duyệt, bị từ chối hoặc hết hạn.
/// Cũng dùng làm "mở khoá chỉnh sửa": mọi thay đổi cấu hình cần một lần duyệt còn hiệu lực.
/// </summary>
sealed class LoginForm : Form
{
    readonly string _api;
    readonly Label _code = new(), _status = new();
    readonly FlatButton _open = new() { Caption = "Mở trình duyệt", Primary = true, Width = 190 };
    readonly FlatButton _cancel = new() { Caption = "Huỷ", Width = 120 };
    readonly CancellationTokenSource _cts = new();
    string _url = "";

    public LoginResult? Result { get; private set; }

    public LoginForm(string api, string title = "Đăng nhập", string? reason = null)
    {
        _api = api.Trim();
        Text = title; ClientSize = new Size(520, 330); StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        var head = new Label { Text = reason ?? "Đăng nhập tài khoản webapp để dùng gateway", ForeColor = Theme.Text, Font = new Font("Segoe UI Semibold", 12f), AutoSize = false, Location = new Point(24, 20), Size = new Size(472, 28), BackColor = Color.Transparent };
        var help = new Label { Text = "1. Bấm “Mở trình duyệt” (hoặc vào địa chỉ bên dưới).\n2. Đăng nhập webapp, đối chiếu mã này rồi bấm Duyệt.\nApp không bao giờ hỏi mật khẩu của bạn.", ForeColor = Theme.Muted, AutoSize = false, Location = new Point(24, 54), Size = new Size(472, 62), BackColor = Color.Transparent };
        _code.Font = new Font("Consolas", 34f, FontStyle.Bold); _code.ForeColor = Theme.Teal; _code.AutoSize = false; _code.TextAlign = ContentAlignment.MiddleCenter;
        _code.Location = new Point(24, 124); _code.Size = new Size(472, 70); _code.Text = "…"; _code.BackColor = Color.Transparent;
        _status.ForeColor = Theme.Muted; _status.AutoSize = false; _status.TextAlign = ContentAlignment.MiddleCenter;
        _status.Location = new Point(24, 200); _status.Size = new Size(472, 48); _status.Text = "Đang kết nối server…"; _status.BackColor = Color.Transparent;
        _open.Location = new Point(24, 268); _open.Enabled = false; _cancel.Location = new Point(376, 268);
        _open.Click += (_, _) => OpenBrowser();
        _cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, help, _code, _status, _open, _cancel });
        Shown += async (_, _) => await RunAsync();
        FormClosed += (_, _) => _cts.Cancel();
    }

    void OpenBrowser()
    {
        if (_url.Length == 0) return;
        try { Process.Start(new ProcessStartInfo(_url) { UseShellExecute = true }); }
        catch (Exception) { Clipboard.SetText(_url); _status.Text = "Không mở được trình duyệt — đã chép địa chỉ, hãy dán vào trình duyệt."; }
    }

    async Task RunAsync()
    {
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(_api), Timeout = TimeSpan.FromSeconds(15) };
            var client = new GatewayEnrollClient(http);
            var st = await client.LoginStartAsync(_cts.Token);
            if (st.DeviceCode.Length == 0 || st.UserCode.Length == 0) throw new InvalidOperationException("server không trả mã đăng nhập");
            // Chỉ mở địa chỉ thuộc đúng server đã cấu hình (không mở link tuỳ ý do phản hồi mang về)
            _url = Uri.TryCreate(st.VerifyUrl, UriKind.Absolute, out var u) && (u.Scheme == "https" || u.Scheme == "http") ? st.VerifyUrl : "";
            _code.Text = st.UserCode; _open.Enabled = _url.Length > 0;
            _status.Text = "Chờ bạn duyệt trên trình duyệt…";
            if (_url.Length > 0) OpenBrowser();
            var until = DateTime.UtcNow.AddSeconds(Math.Max(30, st.ExpiresIn));
            while (DateTime.UtcNow < until && !_cts.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Max(2, st.Interval)), _cts.Token);
                var p = await client.LoginPollAsync(st.DeviceCode, _cts.Token);
                if (p.Status == "approved" && p.Token.Length > 0)
                {
                    Result = new LoginResult(p.Token, p.User, p.Uid);
                    DialogResult = DialogResult.OK; Close(); return;
                }
            }
            if (!_cts.IsCancellationRequested) _status.Text = "Mã đã hết hạn. Đóng cửa sổ rồi thử lại.";
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            if (IsDisposed) return;
            _status.Text = ex.Message switch
            {
                "denied" => "Bạn đã từ chối đăng nhập này.",
                "expired" => "Mã đã hết hạn. Đóng cửa sổ rồi thử lại.",
                "rate_limited" => "Server đang bận, thử lại sau ít phút.",
                _ => "Không đăng nhập được: " + ex.Message,
            };
        }
    }
}
