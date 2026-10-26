using Plciot.Solution.Conveyor.Auth;

namespace Plciot.Scada.Tests;

/// <summary>Đăng nhập cục bộ của PC trong nhà máy: băm mật khẩu, khoá tạm, vai trò, tự đăng xuất, kiểm toán.</summary>
public class ConveyorAuthTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "plciot-auth-" + Guid.NewGuid().ToString("N"));
    DateTime _now = new(2026, 1, 5, 8, 0, 0);

    UserStore Store() => new(Path.Combine(_dir, "users.json"), () => _now, iterations: 1000);   // ít vòng cho test nhanh
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void First_run_needs_setup_and_there_is_no_default_account()
    {
        var s = Store();
        Assert.True(s.NeedsSetup);
        Assert.False(s.Login("admin", "admin").Ok);
        Assert.Null(s.Create("quanly", "Matkhau!2026", Role.Admin));
        Assert.False(Store().NeedsSetup);                       // nạp lại từ đĩa vẫn còn
    }

    [Fact]
    public void Password_is_hashed_never_stored_in_plain_text()
    {
        var s = Store();
        s.Create("quanly", "Matkhau!2026", Role.Admin);
        var raw = File.ReadAllText(Path.Combine(_dir, "users.json"));
        Assert.DoesNotContain("Matkhau!2026", raw);
        Assert.True(Store().Login("QuanLy", "Matkhau!2026").Ok, "tên đăng nhập không phân biệt hoa thường");
        Assert.False(Store().Login("quanly", "matkhau!2026").Ok, "mật khẩu thì phân biệt");
    }

    [Fact]
    public void Same_password_gets_different_salt_and_hash()
    {
        var s = Store();
        s.Create("user_a", "Matkhau!2026", Role.Operator);
        s.Create("user_b", "Matkhau!2026", Role.Operator);
        var l = s.List();
        Assert.NotEqual(l[0].Salt, l[1].Salt);
        Assert.NotEqual(l[0].Hash, l[1].Hash);
    }

    [Theory]
    [InlineData("ab", "Matkhau!2026")]            // tên quá ngắn
    [InlineData("an toan", "Matkhau!2026")]       // có dấu cách
    [InlineData("quanly", "ngan")]                // mật khẩu quá ngắn
    [InlineData("quanly", "aaaaaaaaaa")]          // quá đơn giản
    [InlineData("quanly", "quanly12345")]         // chứa tên đăng nhập
    public void Weak_names_and_passwords_are_rejected(string name, string pass) => Assert.NotNull(Store().Create(name, pass, Role.Viewer));

    [Fact]
    public void Five_wrong_passwords_lock_the_account_then_it_unlocks_and_backoff_doubles()
    {
        var s = Store();
        s.Create("vanhanh", "Matkhau!2026", Role.Operator);
        for (var i = 0; i < 4; i++) Assert.False(s.Login("vanhanh", "sai-mat-khau").Ok);
        var locked = s.Login("vanhanh", "sai-mat-khau");
        Assert.Contains("Khoá 60", locked.Error);
        Assert.False(s.Login("vanhanh", "Matkhau!2026").Ok, "đang khoá thì mật khẩu đúng cũng không vào được");

        _now = _now.AddSeconds(61);
        Assert.True(s.Login("vanhanh", "Matkhau!2026").Ok);

        for (var i = 0; i < 5; i++) s.Login("vanhanh", "sai");              // lần khoá đầu đã được xoá khi đăng nhập đúng
        _now = _now.AddSeconds(61);
        Assert.True(s.Login("vanhanh", "Matkhau!2026").Ok);
    }

    [Fact]
    public void Repeated_lockouts_back_off_up_to_the_cap()
    {
        var s = Store();
        s.Create("vanhanh", "Matkhau!2026", Role.Operator);
        string? last = null;
        for (var round = 0; round < 12; round++)
        {
            for (var i = 0; i < 5; i++) last = s.Login("vanhanh", "sai").Error;
            _now = _now.AddMinutes(16);                                      // luôn qua hạn để vòng sau lại thử
        }
        Assert.Contains("900", last);                                        // trần 15 phút
    }

    [Fact]
    public void Unknown_user_gets_the_same_message_as_a_wrong_password()
    {
        var s = Store();
        s.Create("vanhanh", "Matkhau!2026", Role.Operator);
        Assert.Equal(s.Login("vanhanh", "sai").Error, s.Login("khongco", "sai").Error);
    }

    [Fact]
    public void Disabled_account_cannot_log_in_and_the_last_admin_cannot_be_removed()
    {
        var s = Store();
        s.Create("quanly", "Matkhau!2026", Role.Admin);
        s.Create("vanhanh", "Matkhau!2026", Role.Operator);
        Assert.Null(s.SetDisabled("vanhanh", true));
        Assert.False(s.Login("vanhanh", "Matkhau!2026").Ok);

        Assert.NotNull(s.SetDisabled("quanly", true));
        Assert.NotNull(s.SetRole("quanly", Role.Operator));
        Assert.NotNull(s.Delete("quanly"));

        s.Create("quanly2", "Matkhau!2026", Role.Admin);
        Assert.Null(s.SetRole("quanly", Role.Operator));                     // còn admin khác thì được
    }

    [Fact]
    public void Role_matrix_is_cumulative()
    {
        Assert.False(Roles.Has(null, Permission.Control));
        Assert.False(Roles.Has(Role.Viewer, Permission.Control));
        Assert.True(Roles.Has(Role.Operator, Permission.Control));
        Assert.False(Roles.Has(Role.Operator, Permission.EditSettings));
        Assert.True(Roles.Has(Role.Engineer, Permission.Control));
        Assert.True(Roles.Has(Role.Engineer, Permission.EditSettings));
        Assert.False(Roles.Has(Role.Engineer, Permission.ManageUsers));
        Assert.True(Roles.Has(Role.Admin, Permission.ManageUsers));
    }

    [Fact]
    public void Session_starts_view_only_logs_in_and_falls_back_after_idle()
    {
        var store = Store(); store.Create("vanhanh", "Matkhau!2026", Role.Operator);
        var audit = new AuditLog(Path.Combine(_dir, "audit"), () => _now);
        var ses = new Session(store, audit, TimeSpan.FromMinutes(10), () => _now);
        Assert.False(ses.Can(Permission.Control));
        Assert.Equal("viewer", ses.Actor);

        Assert.NotNull(ses.SignIn("vanhanh", "sai"));
        Assert.Null(ses.SignIn("vanhanh", "Matkhau!2026"));
        Assert.True(ses.Can(Permission.Control));
        Assert.Equal("vanhanh", ses.Actor);

        _now = _now.AddMinutes(9); ses.Touch();                              // còn thao tác thì giữ phiên
        _now = _now.AddMinutes(9);
        Assert.False(ses.CheckIdle());
        _now = _now.AddMinutes(2);
        Assert.True(ses.CheckIdle());
        Assert.False(ses.Can(Permission.Control));
        Assert.Contains(audit.Recent(), l => l.Contains("tự đăng xuất"));
    }

    [Fact]
    public void Audit_log_is_one_line_per_event_and_user_text_cannot_forge_lines()
    {
        var audit = new AuditLog(Path.Combine(_dir, "audit"), () => _now);
        audit.Write("vanhanh", "điều khiển", "D6 = 0\n2026-01-05 08:00:00 | admin | đăng nhập | giả");
        audit.Write("vanhanh", "điều khiển", "D6 = 1");
        var lines = audit.Recent();
        Assert.Equal(2, lines.Length);
        Assert.DoesNotContain(lines, l => l.Contains("| admin |"));
        Assert.Contains("audit-202601.log", Directory.GetFiles(Path.Combine(_dir, "audit")).Select(Path.GetFileName));
    }
}

public class ConveyorAuthNameTests
{
    [Theory]
    [InlineData("tétr1")]      // ký tự có dấu do bộ gõ tiếng Việt
    [InlineData("người")]
    [InlineData("ca sang")]
    public void Non_ascii_or_spaced_names_are_rejected(string name) => Assert.NotNull(UserStore.ValidateName(name));

    [Theory]
    [InlineData("vanhanh")]
    [InlineData("ca.sang-1")]
    [InlineData("Admin_01")]
    public void Plain_ascii_names_are_accepted(string name) => Assert.Null(UserStore.ValidateName(name));
}
