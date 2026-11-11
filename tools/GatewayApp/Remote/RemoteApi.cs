using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace GatewayApp;

/// <summary>
/// Máy chủ HTTP tối giản (TcpListener, không cần quyền admin/urlacl) cho tool admin nối tới gateway bằng IP.
/// Mọi yêu cầu cần "Authorization: Bearer &lt;token&gt;". Giao thức là HTTP thường: dùng trong LAN tin cậy hoặc VPN.
/// </summary>
public sealed class RemoteApi : IDisposable
{
    public delegate Task<(int Status, string Json)> Handler(string method, string path, string body);

    readonly TcpListener _l;
    readonly byte[] _token;
    readonly Handler _h;
    readonly CancellationTokenSource _cts = new();
    public IPEndPoint Endpoint => (IPEndPoint)_l.LocalEndpoint;

    public RemoteApi(IPAddress bind, int port, string token, Handler h)
    {
        _l = new TcpListener(bind, port); _token = Encoding.UTF8.GetBytes(token); _h = h;
    }

    public void Start() { _l.Start(); _ = Task.Run(Loop); }

    async Task Loop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient c;
            try { c = await _l.AcceptTcpClientAsync(_cts.Token); }
            catch (Exception) { return; }
            _ = Task.Run(() => Serve(c));
        }
    }

    async Task Serve(TcpClient c)
    {
        using (c)
        {
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token); cts.CancelAfter(TimeSpan.FromSeconds(30));
                var s = c.GetStream();
                var buf = new List<byte>(); var tmp = new byte[4096]; int hdrEnd;
                while ((hdrEnd = Find(buf)) < 0)
                {
                    if (buf.Count > 65536) return;
                    var n = await s.ReadAsync(tmp, cts.Token); if (n <= 0) return;
                    buf.AddRange(tmp.AsSpan(0, n).ToArray());
                }
                var head = Encoding.ASCII.GetString(buf.GetRange(0, hdrEnd).ToArray()).Split("\r\n");
                var rl = head[0].Split(' ');
                if (rl.Length < 2) return;
                var hdr = head.Skip(1).Select(x => x.Split(':', 2)).Where(x => x.Length == 2).ToDictionary(x => x[0].Trim().ToLowerInvariant(), x => x[1].Trim());
                var len = hdr.TryGetValue("content-length", out var cl) && int.TryParse(cl, out var li) ? li : 0;
                if (len is < 0 or > 4_000_000) { await Send(s, 413, "{\"ok\":false,\"err\":\"too_large\"}"); return; }
                var bodyBytes = buf.GetRange(hdrEnd + 4, buf.Count - hdrEnd - 4);
                while (bodyBytes.Count < len)
                {
                    var n = await s.ReadAsync(tmp, cts.Token); if (n <= 0) return;
                    bodyBytes.AddRange(tmp.AsSpan(0, n).ToArray());
                }
                if (Locked()) { await Send(s, 429, "{\"ok\":false,\"err\":\"too_many_attempts\"}"); return; }
                var auth = hdr.TryGetValue("authorization", out var a) ? a : "";
                var given = Encoding.UTF8.GetBytes(auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? auth[7..].Trim() : "");
                if (given.Length != _token.Length || !CryptographicOperations.FixedTimeEquals(given, _token)) { Fail(); await Send(s, 401, "{\"ok\":false,\"err\":\"unauthorized\"}"); return; }
                var (st, json) = await _h(rl[0], rl[1], Encoding.UTF8.GetString(bodyBytes.Take(len).ToArray()));
                await Send(s, st, json);
            }
            catch (Exception) { /* kết nối hỏng: bỏ */ }
        }
    }

    // chống dò mã: 5 lần sai trong 60 giây thì khoá mọi yêu cầu 60 giây
    readonly object _fg = new(); int _fails; DateTime _failStart = DateTime.MinValue;
    bool Locked() { lock (_fg) return _fails >= 5 && (DateTime.UtcNow - _failStart).TotalSeconds < 60; }
    void Fail() { lock (_fg) { if ((DateTime.UtcNow - _failStart).TotalSeconds >= 60) { _fails = 0; _failStart = DateTime.UtcNow; } _fails++; } }

    static int Find(List<byte> b)
    {
        for (var i = 0; i + 3 < b.Count; i++) if (b[i] == 13 && b[i + 1] == 10 && b[i + 2] == 13 && b[i + 3] == 10) return i;
        return -1;
    }

    static async Task Send(NetworkStream s, int status, string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var reason = status switch { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 404 => "Not Found", 413 => "Payload Too Large", 429 => "Too Many Requests", _ => "Error" };
        var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await s.WriteAsync(head); await s.WriteAsync(body); await s.FlushAsync();
    }

    public void Dispose() { _cts.Cancel(); try { _l.Stop(); } catch (Exception) { } }
}
