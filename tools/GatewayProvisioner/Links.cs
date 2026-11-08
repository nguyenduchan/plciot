using System.IO.Ports;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace GatewayProvisioner;

/// <summary>Đường nối tới gateway. Mọi đường dùng cùng nội dung JSON; chỉ khác cách vận chuyển.</summary>
public interface IGatewayLink : IDisposable
{
    /// <summary>Đọc mã yêu cầu (ID máy + mã thử thách) gateway đang hiển thị.</summary>
    Task<string> ReadRequestAsync();
    /// <summary>Ghi gói nạp; trả (ok, mã lỗi do gateway báo).</summary>
    Task<(bool Ok, string? Error)> WriteAsync(object payload);
}

public static class Links
{
    /// <summary>"COM3" / "COM3:9600" → cổng nối tiếp; "tcp://host:port" → dòng lệnh qua TCP; còn lại → HTTP LAN.</summary>
    public static IGatewayLink Open(string target)
    {
        var t = (target ?? "").Trim();
        if (t.Length == 0) throw new InvalidOperationException("Chưa chọn cách kết nối gateway (cổng COM hoặc địa chỉ).");
        if (t.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return new FileLink(t[5..].Trim().Trim('"'));
        if (t.StartsWith("COM", StringComparison.OrdinalIgnoreCase))
        {
            var parts = t.Split(':');
            var baud = parts.Length > 1 && int.TryParse(parts[1], out var b) ? b : 115200;
            var sp = new SerialPort(parts[0].ToUpperInvariant(), baud, Parity.None, 8, StopBits.One)
            {
                ReadTimeout = 10_000, WriteTimeout = 5_000, NewLine = "\n", DtrEnable = true,
            };
            try { sp.Open(); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                throw new InvalidOperationException($"Không mở được {parts[0].ToUpperInvariant()}. Kiểm tra cáp USB đã cắm và không có chương trình khác đang dùng cổng này.");
            }
            return new LineLink(sp.BaseStream, sp);
        }
        if (t.StartsWith("tcp://", StringComparison.OrdinalIgnoreCase))
        {
            var u = new Uri(t);
            var c = new TcpClient();
            try { c.Connect(u.Host, u.Port > 0 ? u.Port : 8023); }
            catch (SocketException)
            {
                c.Dispose();
                throw new InvalidOperationException($"Không kết nối được {u.Host}:{u.Port}. Kiểm tra gateway đã bật và địa chỉ đúng.");
            }
            return new LineLink(c.GetStream(), c);
        }
        return new HttpLink(Provisioner.BaseUrl(t));
    }
}

/// <summary>Dòng lệnh JSON, mỗi lệnh một dòng kết thúc "\n" (UART hoặc TCP):
///   → {"cmd":"get_request"}            ← {"ok":true,"request":"GW7K2M9XA4QP8RTC"}
///   → {"cmd":"provision", …gói nạp…}   ← {"ok":true} | {"ok":false,"error":"…"}</summary>
public sealed class LineLink : IGatewayLink
{
    readonly Stream _s;
    readonly IDisposable _owner;
    readonly StreamReader _r;

    public LineLink(Stream s, IDisposable owner)
    {
        _s = s; _owner = owner;
        _r = new StreamReader(s, new UTF8Encoding(false));
    }

    async Task<JsonElement> CallAsync(object cmd)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(cmd) + "\n");
        await _s.WriteAsync(bytes);
        await _s.FlushAsync();
        var read = _r.ReadLineAsync();
        // Bỏ qua dòng log/nhiễu của MCU: chỉ nhận dòng bắt đầu bằng '{'.
        for (var i = 0; i < 50; i++)
        {
            var done = await Task.WhenAny(read, Task.Delay(10_000));
            if (done != read) throw new InvalidOperationException("Gateway không trả lời. Kiểm tra gateway đang ở chế độ nạp.");
            var line = (await read)?.Trim();
            if (line is null) throw new InvalidOperationException("Gateway đã ngắt kết nối.");
            if (line.StartsWith('{'))
            {
                try { return JsonSerializer.Deserialize<JsonElement>(line); } catch { /* dòng hỏng, đọc tiếp */ }
            }
            read = _r.ReadLineAsync();
        }
        throw new InvalidOperationException("Gateway trả về dữ liệu không đọc được.");
    }

    public async Task<string> ReadRequestAsync()
    {
        var j = await CallAsync(new { cmd = "get_request" });
        if (!j.TryGetProperty("request", out var r)) throw new InvalidOperationException("Gateway không trả mã yêu cầu.");
        return r.GetString() ?? "";
    }

    public async Task<(bool, string?)> WriteAsync(object payload)
    {
        var dict = JsonSerializer.SerializeToElement(payload).EnumerateObject()
            .ToDictionary(p => p.Name, p => (object)p.Value);
        dict["cmd"] = "provision";
        var j = await CallAsync(dict);
        var ok = j.TryGetProperty("ok", out var o) && o.ValueKind == JsonValueKind.True;
        return (ok, j.TryGetProperty("error", out var e) ? e.GetString() : null);
    }

    public void Dispose() { _r.Dispose(); _owner.Dispose(); }
}

/// <summary>HTTP LAN: GET /provision/request, POST /provision.</summary>
public sealed class HttpLink : IGatewayLink
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    readonly string _base;
    public HttpLink(string baseUrl) { _base = baseUrl; }

    public async Task<string> ReadRequestAsync()
    {
        try
        {
            var j = await Http.GetFromJsonAsync<JsonElement>($"{_base}/provision/request");
            return j.GetProperty("request").GetString() ?? "";
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new InvalidOperationException("Không kết nối được gateway. Kiểm tra gateway đã bật và cùng mạng LAN với máy này.");
        }
    }

    public async Task<(bool, string?)> WriteAsync(object payload)
    {
        try
        {
            using var resp = await Http.PostAsJsonAsync($"{_base}/provision", payload);
            var body = await resp.Content.ReadAsStringAsync();
            JsonElement j = default;
            try { j = JsonSerializer.Deserialize<JsonElement>(body); } catch { /* không phải JSON */ }
            var ok = resp.IsSuccessStatusCode && j.ValueKind == JsonValueKind.Object
                && j.TryGetProperty("ok", out var o) && o.ValueKind == JsonValueKind.True;
            string? err = j.ValueKind == JsonValueKind.Object && j.TryGetProperty("error", out var e) ? e.GetString() : null;
            return (ok, ok ? null : err ?? $"http_{(int)resp.StatusCode}");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new InvalidOperationException("Mất kết nối LAN tới gateway khi đang ghi.");
        }
    }

    public void Dispose() { }
}

/// <summary>
/// "file:C:\\kit\\gw01.json": ghi gói nạp ra file thay vì ghi vào thiết bị (gateway PC cài sau, hoặc giao cho khách).
/// Nếu có giấy phép (gateway PC không internet) thì ghi thêm "&lt;tên&gt;.license.json" — file này khách nhập vào gateway.
/// </summary>
public sealed class FileLink : IGatewayLink
{
    readonly string _path;
    public FileLink(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("Chưa nhập đường dẫn file (ví dụ file:C:\\kit\\gw01.json).");
        _path = path;
    }

    public Task<string> ReadRequestAsync() =>
        throw new InvalidOperationException("Nạp ra file không đọc được ID từ gateway. Nhập ID máy của PC khách (hiện trên màn hình kích hoạt của gateway PC).");

    public async Task<(bool, string?)> WriteAsync(object payload)
    {
        var opts = new JsonSerializerOptions { WriteIndented = true };
        try
        {
            var full = Path.GetFullPath(_path);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            var el = JsonSerializer.SerializeToElement(payload);
            if (el.TryGetProperty("licenseFile", out var lic) && lic.ValueKind == JsonValueKind.Object)
            {
                var licPath = Path.ChangeExtension(full, null) + ".license.json";
                await File.WriteAllTextAsync(licPath, JsonSerializer.Serialize(lic, opts));
                var dict = el.EnumerateObject().Where(p => p.Name != "licenseFile").ToDictionary(p => p.Name, p => (object)p.Value);
                await File.WriteAllTextAsync(full, JsonSerializer.Serialize(dict, opts));
            }
            else await File.WriteAllTextAsync(full, JsonSerializer.Serialize(el, opts));
            return (true, null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return (false, "storage_failed");
        }
    }

    public void Dispose() { }
}
