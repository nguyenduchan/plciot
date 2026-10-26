namespace Plciot.Solution.Conveyor.Auth;

/// <summary>
/// Phiên làm việc tại máy. Mặc định là chế độ chỉ xem (không đăng nhập); đăng nhập nâng quyền, hết thời gian
/// không thao tác thì tự về chế độ chỉ xem để ca sau không dùng nhầm phiên của ca trước.
/// </summary>
public sealed class Session
{
    readonly UserStore _store;
    readonly AuditLog _audit;
    readonly Func<DateTime> _now;
    DateTime _lastActivity;

    public Session(UserStore store, AuditLog audit, TimeSpan? idle = null, Func<DateTime>? now = null)
    {
        _store = store; _audit = audit; _now = now ?? (() => DateTime.Now);
        IdleTimeout = idle ?? TimeSpan.FromMinutes(10);
        _lastActivity = _now();
    }

    public TimeSpan IdleTimeout { get; }
    public UserRecord? User { get; private set; }
    public Role? Role => User?.Role;
    public string Actor => User?.Name ?? "viewer";
    public bool Can(Permission p) => Roles.Has(Role, p);
    public UserStore Store => _store;
    public AuditLog Audit => _audit;
    public event Action? Changed;

    public string? SignIn(string name, string password)
    {
        var r = _store.Login(name, password);
        if (!r.Ok) { _audit.Write(string.IsNullOrWhiteSpace(name) ? "?" : name.Trim(), "đăng nhập thất bại", r.Error ?? ""); return r.Error; }
        User = r.User; _lastActivity = _now();
        _audit.Write(User!.Name, "đăng nhập", Roles.Display(User.Role));
        Changed?.Invoke();
        return null;
    }

    public void SignOut(string reason = "đăng xuất")
    {
        if (User == null) return;
        _audit.Write(User.Name, reason);
        User = null;
        Changed?.Invoke();
    }

    /// <summary>Gọi mỗi khi người dùng thao tác (chuột, phím).</summary>
    public void Touch() => _lastActivity = _now();

    /// <summary>Gọi định kỳ: đăng xuất nếu quá hạn. Trả true nếu vừa đăng xuất.</summary>
    public bool CheckIdle()
    {
        if (User == null || _now() - _lastActivity < IdleTimeout) return false;
        SignOut("tự đăng xuất (không thao tác)");
        return true;
    }

    /// <summary>Thời gian còn lại trước khi tự đăng xuất; null nếu chưa đăng nhập.</summary>
    public TimeSpan? IdleLeft => User == null ? null : IdleTimeout - (_now() - _lastActivity);
}
