namespace Plciot.Solution.Conveyor.Auth;

/// <summary>Vai trò cộng dồn: mỗi vai trò có mọi quyền của vai trò thấp hơn.</summary>
public enum Role { Viewer = 0, Operator = 1, Engineer = 2, Admin = 3 }

public enum Permission
{
    /// <summary>Chạy/dừng, chế độ, đầu ra thủ công, mục tiêu, xoá đếm.</summary>
    Control,
    /// <summary>Sửa cài đặt PLC / cloud.</summary>
    EditSettings,
    /// <summary>Thêm, khoá, đổi quyền, đặt lại mật khẩu; xem nhật ký kiểm toán.</summary>
    ManageUsers,
}

public static class Roles
{
    public static bool Has(Role? role, Permission p) => role is { } r && p switch
    {
        Permission.Control => r >= Role.Operator,
        Permission.EditSettings => r >= Role.Engineer,
        Permission.ManageUsers => r >= Role.Admin,
        _ => false,
    };

    public static string Display(Role r) => r switch
    {
        Role.Viewer => "Chỉ xem",
        Role.Operator => "Vận hành",
        Role.Engineer => "Kỹ thuật",
        Role.Admin => "Quản trị",
        _ => r.ToString(),
    };
}
