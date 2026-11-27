using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace GatewayApp;

/// <summary>
/// Chống giả mạo gói cập nhật GatewayApp: chỉ cài gói có chữ ký ECDSA P-256 khớp khoá công khai gắn cứng dưới đây
/// (ký bằng cloud/app/scripts/sign-gateway-release.js, khoá riêng ~/.plciot/gw-sign.pem NGOÀI repo; publish-gateway.ps1 tự ký).
/// Thông điệp: <c>gw1|&lt;sha256 zip&gt;|&lt;version&gt;|&lt;apiLevel&gt;</c>. Kẻ chiếm server/Cloudflare hoặc sửa server.json cũng không cài được exe lạ.
/// Thuần (không WinForms) để GatewayApp.Tests kiểm trực tiếp.
/// </summary>
public static class UpdateSignature
{
    /// <summary>
    /// Khoá công khai (SPKI DER, base64url) được tin. Đổi khoá: THÊM khoá mới vào danh sách, phát hành một bản ký bằng khoá CŨ,
    /// đợi mọi gateway lên bản đó (bảng gateway_clients) rồi mới ký bằng khoá mới và bỏ khoá cũ.
    /// </summary>
    public static readonly string[] TrustedKeys =
    {
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFCZWIEIwCZfUgDuOeyy1eFIELsh1IHuNzMn8rxXyw6HItLCa-mnu9d2nB5duitszIpioWWrYKHrsaGSllbQD_Q",
    };

    public static byte[] Message(string sha256Hex, string version, int apiLevel) =>
        Encoding.UTF8.GetBytes($"gw1|{sha256Hex.ToLowerInvariant()}|{version}|{apiLevel}");

    /// <summary>Đúng khi <paramref name="sigB64u"/> là chữ ký hợp lệ của một khoá trong <paramref name="keys"/> (mặc định <see cref="TrustedKeys"/>).</summary>
    public static bool Verify(string sha256Hex, string version, int apiLevel, string? sigB64u, IEnumerable<string>? keys = null)
    {
        if (string.IsNullOrEmpty(sigB64u) || sha256Hex.Length != 64) return false;
        byte[] sig;
        try { sig = FromB64u(sigB64u); } catch (FormatException) { return false; }
        if (sig.Length != 64) return false;
        var msg = Message(sha256Hex, version, apiLevel);
        foreach (var k in keys ?? TrustedKeys)
        {
            try
            {
                using var ec = ECDsa.Create();
                ec.ImportSubjectPublicKeyInfo(FromB64u(k), out _);
                if (ec.VerifyData(msg, sig, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) return true;
            }
            catch (CryptographicException) { }
            catch (FormatException) { }
        }
        return false;
    }

    /// <summary>
    /// Server cập nhật được phép: https (chứng chỉ kiểm theo kho CA của Windows), hoặc http CHỈ tới máy trong LAN
    /// (server cài trên PC nội bộ không có chứng chỉ công khai). Gói luôn phải có chữ ký nên http LAN chỉ lộ nội dung, không cài được bản lạ.
    /// </summary>
    public static bool ServerAllowed(string server, out string why)
    {
        why = "";
        if (!Uri.TryCreate(server?.Trim(), UriKind.Absolute, out var u)) { why = "địa chỉ server không hợp lệ"; return false; }
        if (u.Scheme == Uri.UriSchemeHttps) return true;
        if (u.Scheme == Uri.UriSchemeHttp && IsLanHost(u.Host)) return true;
        why = $"chỉ cập nhật qua https:// (đang đặt {u.Scheme}://{u.Host})";
        return false;
    }

    public static bool IsLanHost(string host)
    {
        host = host.Trim('[', ']').TrimEnd('.').ToLowerInvariant();
        if (host == "localhost" || host.EndsWith(".local") || host.EndsWith(".lan") || host.EndsWith(".home.arpa")) return true;
        if (!IPAddress.TryParse(host, out var ip)) return !host.Contains('.');   // tên một nhãn (máy trong mạng nội bộ)
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily == AddressFamily.InterNetworkV6) return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || (ip.GetAddressBytes()[0] & 0xFE) == 0xFC;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
    }

    static byte[] FromB64u(string s)
    {
        s = s.Trim().Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
