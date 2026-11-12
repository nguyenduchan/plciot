using System.Security.Cryptography;
using System.Text;

namespace Plciot.Scada.Services.Ui;

/// <summary>
/// Danh tính mật mã của gateway: cặp khoá ECDSA P-256. Khoá RIÊNG nằm trên máy (ScadaConfig.GatewayKey, mã hoá DPAPI khi lưu);
/// khoá CÔNG KHAI được gửi lên server lúc ghép cặp. ID máy (hw) = băm của khoá công khai (server tính cùng công thức).
/// Mọi yêu cầu ghép cặp / enroll / config đều ký bằng khoá riêng — chỉ có ảnh QR thì không làm được gì.
/// </summary>
public sealed class GatewayIdentity : IDisposable
{
    const string B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    readonly ECDsa _key;

    GatewayIdentity(ECDsa key) => _key = key;

    /// <summary>Nạp khoá từ cấu hình (PKCS#8 base64); chưa có thì sinh mới. <paramref name="created"/> = true khi vừa sinh (cần lưu cấu hình).</summary>
    public static GatewayIdentity LoadOrCreate(ref string pkcs8Base64, out bool created)
    {
        created = false;
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        if (!string.IsNullOrWhiteSpace(pkcs8Base64))
        {
            try { key.ImportPkcs8PrivateKey(Convert.FromBase64String(pkcs8Base64), out _); return new GatewayIdentity(key); }
            catch (Exception e) when (e is CryptographicException or FormatException) { key.Dispose(); key = ECDsa.Create(ECCurve.NamedCurves.nistP256); }
        }
        pkcs8Base64 = Convert.ToBase64String(key.ExportPkcs8PrivateKey());
        created = true;
        return new GatewayIdentity(key);
    }

    /// <summary>Khoá công khai SPKI DER, base64url (server: crypto.createPublicKey({format:'der',type:'spki'})).</summary>
    public string PublicKey => B64u(_key.ExportSubjectPublicKeyInfo());

    /// <summary>ID máy: 20 ký tự Crockford đầu của SHA-256(SPKI). Trùng với server (gatewayKey.js parsePubkey).</summary>
    public string Hw
    {
        get
        {
            var h = SHA256.HashData(_key.ExportSubjectPublicKeyInfo());
            var sb = new StringBuilder(); var bits = 0; var acc = 0;
            foreach (var b in h)
            {
                acc = (acc << 8) | b; bits += 8;
                while (bits >= 5 && sb.Length < 20) { sb.Append(B32[(acc >> (bits - 5)) & 31]); bits -= 5; }
                if (sb.Length >= 20) break;
            }
            return sb.ToString();
        }
    }

    /// <summary>Chữ ký IEEE P1363 (r||s) của chuỗi UTF-8, base64url.</summary>
    public string Sign(string message) =>
        B64u(_key.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    /// <summary>Chuẩn hoá mã ghép cặp giống server: hoa, bỏ khoảng trắng và '-', O→0, I/L→1.</summary>
    public static string NormalizeCode(string raw) =>
        new string(raw.ToUpperInvariant().Where(c => c != '-' && !char.IsWhiteSpace(c)).Select(c => c == 'O' ? '0' : c is 'I' or 'L' ? '1' : c).ToArray());

    /// <summary>Chứng minh cho /gateway/pair.</summary>
    public (long Ts, string Sig) PairProof(string code)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return (ts, Sign($"pair|{NormalizeCode(code)}|{ts}"));
    }

    /// <summary>Chứng minh cho /gateway/enroll (kind = "enroll") và /gateway/config (kind = "config"); site/device lấy từ QR.</summary>
    public (long Ts, string Sig) RequestProof(string kind, string site, string device)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return (ts, Sign($"{kind}|{site}|{device}|{ts}"));
    }

    /// <summary>Lấy site/device từ chuỗi QR (base64url JSON) hoặc link login.html?claim=…</summary>
    public static (string Site, string Device)? SiteDeviceOfQr(string qr)
    {
        try
        {
            var raw = qr.Trim();
            var i = raw.IndexOf("claim=", StringComparison.Ordinal);
            if (i >= 0) raw = Uri.UnescapeDataString(raw[(i + 6)..].Split('&')[0]);
            var json = raw.StartsWith('{') ? raw : Encoding.UTF8.GetString(FromB64u(raw));
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var r = doc.RootElement;
            return (r.GetProperty("site").GetString() ?? "", r.GetProperty("device").GetString() ?? "");
        }
        catch (Exception e) when (e is FormatException or System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException) { return null; }
    }

    static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    static byte[] FromB64u(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    public void Dispose() => _key.Dispose();
}
