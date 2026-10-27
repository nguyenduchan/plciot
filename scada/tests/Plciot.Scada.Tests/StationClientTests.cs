using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Plciot.Scada.Tests;

/// <summary>PC nhà máy ghép cặp bằng mã và ký request bằng khoá thiết bị (khớp cloud/app/src/stationAuth.js).</summary>
public class StationClientTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "plc-station-" + Guid.NewGuid().ToString("N"));
    WebApplication? _app;
    string? _pubKey;
    readonly HashSet<string> _seenSigs = new();
    int _cmdOk;

    public StationClientTests() => Directory.CreateDirectory(_dir);

    async Task<string> StartFakeCloud()
    {
        var b = WebApplication.CreateBuilder();
        b.Logging.ClearProviders();
        b.WebHost.UseUrls("http://127.0.0.1:0");
        _app = b.Build();
        _app.MapPost("/api/station/pair", async (HttpContext c) =>
        {
            var j = (await JsonNode.ParseAsync(c.Request.Body))!;
            if (j["code"]!.GetValue<string>() != "ABCD-2345") { c.Response.StatusCode = 401; return Results.Json(new { error = "invalid_pair_code" }, statusCode: 401); }
            _pubKey = j["publicKey"]!.GetValue<string>();
            return Results.Json(new { ok = true, stationId = "pc_test", site = "plantA", device = "plc01", name = j["name"]!.GetValue<string>() });
        });
        _app.MapPost("/api/station/cmd", async (HttpContext c) =>
        {
            using var ms = new MemoryStream(); await c.Request.Body.CopyToAsync(ms);
            var body = ms.ToArray();
            var ts = long.Parse(c.Request.Headers["X-Station-Ts"]!);
            var sig = c.Request.Headers["X-Station-Sig"].ToString();
            if (c.Request.Headers["X-Station-Id"] != "pc_test" || !_seenSigs.Add(sig) || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - ts) > 60_000)
                return Results.Json(new { error = "station_auth_failed" }, statusCode: 401);
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(_pubKey!.Replace('-', '+').Replace('_', '/') + new string('=', (4 - _pubKey.Length % 4) % 4)), out _);
            var raw = Convert.FromBase64String(sig.Replace('-', '+').Replace('_', '/') + new string('=', (4 - sig.Length % 4) % 4));
            var msg = StationClient.Message(ts, "POST", "/api/station/cmd", body);
            if (!key.VerifyData(Encoding.UTF8.GetBytes(msg), raw, HashAlgorithmName.SHA256))
                return Results.Json(new { error = "station_auth_failed" }, statusCode: 401);
            _cmdOk++;
            return Results.Json(new { ok = true, echo = JsonNode.Parse(body) });
        });
        await _app.StartAsync();
        return _app.Urls.First();
    }

    [Fact]
    public async Task Pair_then_signed_command_is_accepted_and_survives_restart()
    {
        var url = await StartFakeCloud();
        var idPath = Path.Combine(_dir, "station.json");
        using (var c = new StationClient(url, idPath))
        {
            Assert.False(c.IsPaired);
            await Assert.ThrowsAsync<InvalidOperationException>(() => c.PairAsync("SAI-SAI00", "PC 1"));
            var id = await c.PairAsync("ABCD-2345", "PC chuyền 1");
            Assert.Equal("pc_test", id.StationId);
            var (st, body) = await c.WriteAsync(7, 25);
            Assert.Equal(200, st);
            Assert.Equal(25, body["echo"]!["v"]!.GetValue<int>());
        }
        // khởi động lại: danh tính đọc từ đĩa, vẫn ký được
        using (var c2 = new StationClient(url, idPath))
        {
            Assert.True(c2.IsPaired);
            Assert.Equal(200, (await c2.WriteAsync(7, 30)).Status);
        }
        Assert.Equal(2, _cmdOk);
        if (OperatingSystem.IsWindows())
        {
            var file = File.ReadAllText(idPath);
            Assert.Contains("dpapi:", file);   // khoá riêng không nằm dạng rõ trên đĩa
        }
    }

    [Fact]
    public async Task Unpaired_client_cannot_send_and_forget_clears_identity()
    {
        var url = await StartFakeCloud();
        var idPath = Path.Combine(_dir, "station.json");
        using var c = new StationClient(url, idPath);
        await Assert.ThrowsAsync<InvalidOperationException>(() => c.WriteAsync(7, 1));
        await c.PairAsync("ABCD-2345", "PC");
        c.Forget();
        Assert.False(c.IsPaired);
        Assert.False(File.Exists(idPath));
        await Assert.ThrowsAsync<InvalidOperationException>(() => c.PingAsync());
    }

    [Fact]
    public void Message_format_matches_the_server_contract()
    {
        // sha256("") = e3b0c442... ; node: stationMessage(ts, method, path, '')
        Assert.Equal("1700000000000\nGET\n/api/station/ping\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            StationClient.Message(1700000000000, "get", "/api/station/ping", Array.Empty<byte>()));
    }

    /// <summary>Kiểm chứng chéo với server Node thật: PLCIOT_PAIR_URL=http://localhost:3997 PLCIOT_PAIR_CODE=XXXX-XXXX dotnet test --filter Live</summary>
    [Fact]
    public async Task Live_pairing_against_real_server_when_configured()
    {
        var url = Environment.GetEnvironmentVariable("PLCIOT_PAIR_URL");
        var code = Environment.GetEnvironmentVariable("PLCIOT_PAIR_CODE");
        if (string.IsNullOrEmpty(url) || string.IsNullOrEmpty(code)) return;
        using var c = new StationClient(url, Path.Combine(_dir, "live.json"));
        await c.PairAsync(code, "PC kiểm thử C#");
        var ping = await c.PingAsync();
        Assert.Equal(200, ping.Status);
        Assert.Equal(c.Identity!.Site, ping.Body["site"]!.GetValue<string>());
        var w = await c.WriteAsync(7, 12);
        Assert.True(w.Status is 200 or 503, $"HTTP {w.Status}: {w.Body}"); // 503 = chưa có broker MQTT trong môi trường thử; chữ ký đã được chấp nhận
        Assert.NotEqual(401, w.Status);
    }

    public void Dispose()
    {
        _app?.DisposeAsync().AsTask().GetAwaiter().GetResult();
        try { Directory.Delete(_dir, true); } catch { }
    }
}
