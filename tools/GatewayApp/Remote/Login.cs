namespace GatewayApp;

/// <summary>Đăng nhập bằng mã kết nối (đổi mỗi phút) để nhận mã phiên.</summary>
public sealed class ApiLogin { public string Code { get; set; } = ""; }
public sealed class ApiLoginResult { public bool Ok { get; set; } public string Token { get; set; } = ""; /// <summary>Board MCU: true = lần đăng nhập này vừa GHÉP PC (lần sau vào thẳng).</summary>
    public bool Paired { get; set; } }
