using System.Windows;
using Plciot.Solution.Conveyor.Auth;

namespace Plciot.Solution.Conveyor;

/// <summary>Đăng nhập; nếu chưa có tài khoản nào thì chuyển sang chế độ tạo quản trị viên đầu tiên (không có mật khẩu mặc định).</summary>
public partial class LoginDialog : Window
{
    readonly Session _session;
    readonly bool _setup;

    public LoginDialog(Session session)
    {
        _session = session;
        _setup = session.Store.NeedsSetup;
        InitializeComponent();
        if (_setup)
        {
            Title = "Thiết lập lần đầu";
            Heading.Text = "Tạo quản trị viên";
            SubText.Text = $"Máy này chưa có tài khoản. Tạo tài khoản quản trị đầu tiên (mật khẩu tối thiểu {UserStore.MinPasswordLength} ký tự). Hãy ghi lại và cất ở nơi an toàn.";
            ConfirmRow.Visibility = Visibility.Visible;
            OkBtn.Content = "Tạo và đăng nhập";
        }
        else SubText.Text = "Đăng nhập để điều khiển hoặc đổi cài đặt. Màn hình vẫn xem được khi chưa đăng nhập.";
        Loaded += (_, _) => UserBox.Focus();
    }

    void OnCancel(object s, RoutedEventArgs e) => DialogResult = false;

    void OnOk(object s, RoutedEventArgs e)
    {
        Err.Text = "";
        var name = UserBox.Text.Trim();
        var pass = PassBox.Password;
        if (_setup)
        {
            if (pass != Pass2Box.Password) { Err.Text = "Hai mật khẩu không khớp."; return; }
            var err = _session.Store.Create(name, pass, Role.Admin);
            if (err != null) { Err.Text = err; return; }
            _session.Audit.Write(name, "tạo quản trị viên đầu tiên");
        }
        var login = _session.SignIn(name, pass);
        if (login != null) { Err.Text = login; PassBox.Clear(); PassBox.Focus(); return; }
        DialogResult = true;
    }
}
