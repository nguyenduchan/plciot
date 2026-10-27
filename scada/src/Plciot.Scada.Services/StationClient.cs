using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Plciot.Scada;

/// <summary>Danh tính của PC này đối với cloud sau khi ghép cặp. Khoá riêng được DPAPI (máy) bảo vệ khi lưu đĩa.</summary>
public sealed class StationIdentity
{
    public string StationId { get; set; } = "";
    public string Site { get; set; } = "";
    public string Device { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Khoá công khai SPKI DER, base64url (đúng định dạng server lưu).</summary>
    public string PublicKey { get; set; } = "";
    /// <summary>Khoá riêng PKCS#8 (bản bảo vệ DPAPI trên Windows, tiền tố "dpapi:").</summary>
    public string PrivateKey { get; set; } = "";
}

/// <summary>
/// PC nhà máy ghép cặp với cloud bằng mã do chủ site cấp (Cài đặt → Nhà máy → Thêm PC) và từ đó ký mọi request
/// bằng khoá ECDSA P-256 của chính máy — không mật khẩu, không cần admin. Đổi PC: ghép máy mới, chủ site thu hồi máy cũ.
/// Định dạng chữ ký phải khớp cloud/app/src/stationAuth.js: <c>ts \n METHOD \n path \n sha256hex(body)</c>, chữ ký IEEE-P1363.
/// </summary>
public sealed class StationClient : IDisposable
{
    const string DpapiPrefix = "dpapi:";
    readonly HttpClient _http;
    readonly bool _ownsHttp;
    readonly string _identityPath;
    StationIdentity? _id;

    public StationClient(string baseUrl, string identityPath, HttpClient? http = null)
    {
        _identityPath = identityPath;
        _ownsHttp = http == null;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _id = LoadIdentity(identityPath);
    }

    public static string DefaultIdentityPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlciotScada", "station.json");

    public bool IsPaired => _id != null;
    public StationIdentity? Identity => _id;

    /// <summary>Chuỗi được ký — client và server dựng giống hệt nhau.</summary>
    public static string Message(long tsMs, string method, string path, byte[] body) =>
        $"{tsMs}\n{method.ToUpperInvariant()}\n{path}\n{Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant()}";

    /// <summary>Dấu vân tay máy (chỉ để chủ site nhận ra PC; danh tính thật là khoá riêng).</summary>
    public static string Hwid()
    {
        var raw = Environment.MachineName;
        if (OperatingSystem.IsWindows())
        {
            try { raw += "|" + Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", "")?.ToString(); } catch { }
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..32];
    }

    public async Task<StationIdentity> PairAsync(string code, string name, CancellationToken ct = default)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = B64u(key.ExportSubjectPublicKeyInfo());
        var body = JsonSerializer.Serialize(new { code, publicKey = spki, hwid = Hwid(), name });
        using var res = await _http.PostAsync("api/station/pair", new StringContent(body, Encoding.UTF8, "application/json"), ct);
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct)) ?? new JsonObject();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException(json["error"]?.GetValue<string>() ?? $"HTTP {(int)res.StatusCode}");
        _id = new StationIdentity
        {
            StationId = json["stationId"]!.GetValue<string>(),
            Site = json["site"]!.GetValue<string>(),
            Device = json["device"]!.GetValue<string>(),
            Name = json["name"]?.GetValue<string>() ?? name,
            PublicKey = spki,
            PrivateKey = Protect(Convert.ToBase64String(key.ExportPkcs8PrivateKey())),
        };
        SaveIdentity(_identityPath, _id);
        return _id;
    }

    /// <summary>Gửi một request đã ký. <paramref name="path"/> không kèm query (vd. "/api/station/cmd").</summary>
    public async Task<(int Status, JsonNode Body)> SendAsync(HttpMethod method, string path, object? payload = null, CancellationToken ct = default)
    {
        if (_id == null) throw new InvalidOperationException("PC chưa được ghép cặp.");
        var bytes = payload == null ? Array.Empty<byte>() : Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(Unprotect(_id.PrivateKey)), out _);
        var sig = key.SignData(Encoding.UTF8.GetBytes(Message(ts, method.Method, path, bytes)), HashAlgorithmName.SHA256); // P1363
        using var req = new HttpRequestMessage(method, path.TrimStart('/'));
        req.Headers.Add("X-Station-Id", _id.StationId);
        req.Headers.Add("X-Station-Ts", ts.ToString());
        req.Headers.Add("X-Station-Sig", B64u(sig));
        if (payload != null)
        {
            req.Content = new ByteArrayContent(bytes);
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        using var res = await _http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        JsonNode body;
        try { body = JsonNode.Parse(text) ?? new JsonObject(); } catch (JsonException) { body = new JsonObject { ["raw"] = text }; }
        return ((int)res.StatusCode, body);
    }

    public Task<(int Status, JsonNode Body)> PingAsync(CancellationToken ct = default) => SendAsync(HttpMethod.Get, "/api/station/ping", null, ct);

    /// <summary>Ghi một thanh ghi (whitelist theo server). Lệnh nguy hiểm trả 202 + confirmId nếu cloud đòi nút vật lý.</summary>
    public Task<(int Status, JsonNode Body)> WriteAsync(int address, int value, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "/api/station/cmd", new { a = address, v = value }, ct);

    public Task<(int Status, JsonNode Body)> ConfirmAsync(string confirmId, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Get, "/api/station/confirm/" + Uri.EscapeDataString(confirmId), null, ct);

    /// <summary>Xoá danh tính cục bộ (sau khi chủ site thu hồi, hoặc để ghép lại).</summary>
    public void Forget()
    {
        _id = null;
        try { File.Delete(_identityPath); } catch { }
    }

    public void Dispose() { if (_ownsHttp) _http.Dispose(); }

    /* ---------------------------------------------------------- lưu danh tính */
    static StationIdentity? LoadIdentity(string path)
    {
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<StationIdentity>(File.ReadAllText(path)); } catch { return null; }
    }

    static void SaveIdentity(string path, StationIdentity id)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(id, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, path, overwrite: true);
    }

    static string Protect(string s)
    {
        if (!OperatingSystem.IsWindows()) return s;
        return DpapiPrefix + Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(s), null, DataProtectionScope.LocalMachine));
    }

    static string Unprotect(string s)
    {
        if (!s.StartsWith(DpapiPrefix, StringComparison.Ordinal)) return s;
        if (!OperatingSystem.IsWindows()) throw new CryptographicException("Khoá được bảo vệ bằng DPAPI chỉ mở được trên Windows.");
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(s[DpapiPrefix.Length..]), null, DataProtectionScope.LocalMachine));
    }

    static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
