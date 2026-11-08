using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GatewayLicense;

public enum VerifyError { None, Typo, WrongDevice, Expired }

/// <summary>File khoá do admin cấp cho từng khách: {"v":1,"hw":"GW7K2M9X","key":"<64 hex>"}.</summary>
public sealed record KeyFile(string Hw, string Key)
{
    public static KeyFile Parse(string json)
    {
        var j = JsonSerializer.Deserialize<JsonElement>(json);
        var hw = j.GetProperty("hw").GetString() ?? throw new FormatException("thiếu hw");
        var key = j.GetProperty("key").GetString() ?? throw new FormatException("thiếu key");
        if (key.Length != 64 || !key.All(Uri.IsHexDigit)) throw new FormatException("khoá phải là 64 ký tự hex");
        return new KeyFile(ActivationCode.Normalize(hw), key.ToLowerInvariant());
    }
}

/// <summary>
/// Thuật toán kiểm mã kích hoạt (xem tools/GatewayProvisioner/README.md):
/// mã 20 ký tự = EXP(3) + MAC(16) + CHECK(1), MAC = 80 bit đầu HMAC-SHA256(key, "act2|ID|NONCE|EXP").
/// </summary>
public static class ActivationCode
{
    const string B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, bỏ I L O U
    const int EpochDays = 18262;                           // 2020-01-01 tính theo ngày từ 1970

    /// <summary>Chữ hoa, bỏ khoảng trắng/gạch/chấm, O→0, I/L→1.</summary>
    public static string Normalize(string? raw)
    {
        var sb = new StringBuilder();
        foreach (var ch in (raw ?? "").ToUpperInvariant())
        {
            if (char.IsWhiteSpace(ch) || ch is '-' or '_' or '.') continue;
            sb.Append(ch switch { 'O' => '0', 'I' => '1', 'L' => '1', _ => ch });
        }
        return sb.ToString();
    }

    /// <summary>Mã yêu cầu hiển thị cho người dùng đọc qua điện thoại: ID máy + 8 ký tự thử thách ngẫu nhiên.</summary>
    public static (string Request, string Nonce) NewRequest(string hw)
    {
        var nonce = new string(Enumerable.Range(0, 8).Select(_ => B32[RandomNumberGenerator.GetInt32(32)]).ToArray());
        var id = Normalize(hw);
        return (Group(id + nonce), nonce);
    }

    static string Group(string s) => string.Join('-', Enumerable.Range(0, (s.Length + 3) / 4).Select(i => s.Substring(i * 4, Math.Min(4, s.Length - i * 4))));

    static string Encode(byte[] buf)
    {
        var sb = new StringBuilder();
        int bits = 0, acc = 0;
        foreach (var b in buf)
        {
            acc = (acc << 8) | b; bits += 8;
            while (bits >= 5) { sb.Append(B32[(acc >> (bits - 5)) & 31]); bits -= 5; }
            acc &= (1 << bits) - 1;
        }
        if (bits > 0) sb.Append(B32[(acc << (5 - bits)) & 31]);
        return sb.ToString();
    }

    static char Check(string s)
    {
        var sum = 0;
        for (var i = 0; i < s.Length; i++) sum += B32.IndexOf(s[i]) * (i + 1);
        return B32[sum % 32];
    }

    /// <summary>
    /// Khoá bản quyền như phần mềm thông thường: chỉ gắn với ID máy + hạn dùng, không cần mã thử thách.
    /// MAC = 80 bit đầu HMAC-SHA256(key, "lic1|ID|EXP"). Dùng cho gateway KHÔNG có internet.
    /// </summary>
    public static VerifyError VerifyLicense(string code, string hw, string keyHex, DateTime utcNow, out int expDay)
        => VerifyCore(code, $"lic1|{Normalize(hw)}|", keyHex, utcNow, out expDay);

    /// <param name="hw">ID máy (từ file khoá)</param><param name="nonce">mã thử thách đang hiển thị</param>
    public static VerifyError Verify(string code, string hw, string nonce, string keyHex, DateTime utcNow, out int expDay)
        => VerifyCore(code, $"act2|{Normalize(hw)}|{Normalize(nonce)}|", keyHex, utcNow, out expDay);

    static VerifyError VerifyCore(string code, string msgPrefix, string keyHex, DateTime utcNow, out int expDay)
    {
        expDay = 0;
        var s = Normalize(code);
        if (s.Length != 20 || s.Any(c => B32.IndexOf(c) < 0)) return VerifyError.Typo;
        var body = s[..19];
        if (Check(body) != s[19]) return VerifyError.Typo;
        var expChars = body[..3];
        var key = Convert.FromHexString(keyHex);
        var msg = Encoding.UTF8.GetBytes(msgPrefix + expChars);
        var mac = Encode(HMACSHA256.HashData(key, msg).AsSpan(0, 10).ToArray());
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(mac), Encoding.ASCII.GetBytes(body[3..])))
            return VerifyError.WrongDevice;
        expDay = B32.IndexOf(expChars[0]) * 1024 + B32.IndexOf(expChars[1]) * 32 + B32.IndexOf(expChars[2]);
        if (expDay != 0 && (int)(utcNow - DateTime.UnixEpoch).TotalDays > expDay + EpochDays) return VerifyError.Expired;
        return VerifyError.None;
    }
}
