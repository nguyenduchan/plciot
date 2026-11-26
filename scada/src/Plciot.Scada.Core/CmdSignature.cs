using System.Security.Cryptography;
using System.Text;

namespace Plciot.Scada;

/// <summary>
/// Kiểm chữ ký lệnh server → gateway (khớp cloud/app/src/cmdSign.js): ECDSA P-256 / SHA-256, chữ ký IEEE P1363.
/// Thông điệp ký = "cmd1|&lt;mqttId&gt;|" + JSON lệnh (phần đứng trước <c>,"sig":"…"}</c>, đóng lại bằng '}').
/// mqttId nằm trong thông điệp nên lệnh của gateway khác không phát lại được ở đây.
/// </summary>
public static class CmdSignature
{
    const string Marker = ",\"sig\":\"";

    /// <summary>true = chữ ký đúng; <paramref name="unsigned"/> là JSON lệnh đã bỏ thuộc tính sig (đưa tiếp cho CommandPolicy).</summary>
    /// <param name="prefix">"cmd1" = lệnh điều khiển; "rpc1" = yêu cầu cài đặt từ xa (GatewayAdmin) — chữ ký loại này không dùng được cho loại kia.</param>
    public static bool TryVerify(byte[] payload, string mqttId, string serverKeySpkiB64Url, out byte[] unsigned, string prefix = "cmd1")
    {
        unsigned = payload;
        try
        {
            var raw = Encoding.UTF8.GetString(payload);
            var i = raw.LastIndexOf(Marker, StringComparison.Ordinal);
            if (i < 0 || !raw.EndsWith("\"}", StringComparison.Ordinal)) return false;
            var json = raw[..i] + "}";
            var sig = FromB64u(raw[(i + Marker.Length)..^2]);
            if (sig.Length != 64) return false;
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(FromB64u(serverKeySpkiB64Url), out _);
            var ok = key.VerifyData(Encoding.UTF8.GetBytes($"{prefix}|{mqttId}|{json}"), sig, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            if (ok) unsigned = Encoding.UTF8.GetBytes(json);
            return ok;
        }
        catch (Exception e) when (e is FormatException or CryptographicException or ArgumentException) { return false; }
    }

    static byte[] FromB64u(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}

/// <summary>Mật khẩu cục bộ mở khoá sửa cấu hình/điều khiển tại máy: PBKDF2-SHA256, lưu "pbkdf2$vòng$muối$băm". Không cần Internet/webapp.</summary>
public static class LocalPassword
{
    const int Iterations = 200_000;
    public const int MinLength = 8;

    public static string Create(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string password, string stored)
    {
        try
        {
            var p = stored.Split('$');
            if (p.Length != 4 || p[0] != "pbkdf2" || !int.TryParse(p[1], out var it) || it < 10_000) return false;
            var salt = Convert.FromBase64String(p[2]);
            var want = Convert.FromBase64String(p[3]);
            var got = Rfc2898DeriveBytes.Pbkdf2(password, salt, it, HashAlgorithmName.SHA256, want.Length);
            return CryptographicOperations.FixedTimeEquals(got, want);
        }
        catch (FormatException) { return false; }
    }
}
