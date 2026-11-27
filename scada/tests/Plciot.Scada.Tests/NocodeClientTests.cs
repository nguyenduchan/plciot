using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Plciot.Scada.Services.Ui;
using Xunit;

namespace Plciot.Scada.Tests;

/// <summary>
/// Gateway mua sẵn (no-code) — GatewayApp bắt tay với VPS: request ký bằng khoá gateway PC đúng định dạng server kiểm
/// (cloud/app/src/nocode.js nocodeCaller: kind "nocode-&lt;op&gt;[-&lt;target&gt;]|site|device|ts", IEEE P1363).
/// NOCODE_FIXTURE_OUT=&lt;file&gt; → xuất body để Node xác minh chéo.
/// </summary>
public class NocodeClientTests
{
    sealed class Capture : HttpMessageHandler
    {
        public string Path = "", Body = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            Path = req.RequestUri!.AbsolutePath;
            Body = await req.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json") };
        }
    }

    static byte[] B64u(string s) => Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/') + new string('=', (4 - s.Length % 4) % 4));

    static bool Verify(string pubkey, string msg, string sig)
    {
        using var ec = ECDsa.Create();
        ec.ImportSubjectPublicKeyInfo(B64u(pubkey), out _);
        return ec.VerifyData(Encoding.UTF8.GetBytes(msg), B64u(sig), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    [Fact]
    public async Task Request_no_code_ky_dung_dinh_dang_server()
    {
        var key = "";
        using var id = GatewayIdentity.LoadOrCreate(ref key, out _);
        var cap = new Capture();
        using var http = new HttpClient(cap) { BaseAddress = new Uri("https://example.test") };
        var map = JsonDocument.Parse("{\"control\":\"usr_rw_prot\",\"devices\":[]}").RootElement;
        await new GatewayEnrollClient(http).NocodeAsync("map", "u7", "gpc0000001", id, "gnc0011aabb", new Dictionary<string, object?> { ["map"] = map });

        Assert.Equal("/api/v1/gateway/nocode/map", cap.Path);
        using var doc = JsonDocument.Parse(cap.Body);
        var b = doc.RootElement;
        Assert.Equal("u7", b.GetProperty("site").GetString());
        Assert.Equal("gpc0000001", b.GetProperty("device").GetString());
        Assert.Equal("gnc0011aabb", b.GetProperty("target").GetString());
        Assert.Equal("usr_rw_prot", b.GetProperty("map").GetProperty("control").GetString());   // ánh xạ gửi nguyên (khoá không bị đổi tên)
        var ts = b.GetProperty("ts").GetInt64();
        var sig = b.GetProperty("sig").GetString()!;
        Assert.True(Verify(b.GetProperty("pubkey").GetString()!, $"nocode-map-gnc0011aabb|u7|gpc0000001|{ts}", sig));
        Assert.False(Verify(b.GetProperty("pubkey").GetString()!, $"nocode-map-khac|u7|gpc0000001|{ts}", sig));   // gắn với đúng gateway đích

        var path = Environment.GetEnvironmentVariable("NOCODE_FIXTURE_OUT");
        if (!string.IsNullOrEmpty(path)) File.WriteAllText(path, cap.Body);
    }

    [Fact]
    public async Task List_khong_co_target()
    {
        var key = "";
        using var id = GatewayIdentity.LoadOrCreate(ref key, out _);
        var cap = new Capture();
        using var http = new HttpClient(cap) { BaseAddress = new Uri("https://example.test") };
        await new GatewayEnrollClient(http).NocodeAsync("list", "u7", "gpc0000001", id);
        using var doc = JsonDocument.Parse(cap.Body);
        var b = doc.RootElement;
        Assert.False(b.TryGetProperty("target", out _));
        Assert.True(Verify(b.GetProperty("pubkey").GetString()!, $"nocode-list|u7|gpc0000001|{b.GetProperty("ts").GetInt64()}", b.GetProperty("sig").GetString()!));
    }
}
