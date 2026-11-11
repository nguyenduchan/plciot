using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using GatewayApp;

namespace GatewayApp.Tests;

/// <summary>API admin của gateway: đăng nhập bằng mã tự đổi mỗi phút → mã phiên; phiên sống qua lần đổi mã; khoá khi dò mã.</summary>
public class RemoteApiTests
{
    static int FreePort() { var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); var p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }

    static (RemoteApi Api, HttpClient Http) Start(string code)
    {
        var port = FreePort();
        var api = new RemoteApi(IPAddress.Loopback, port, code, (m, p, b) => Task.FromResult((200, "{\"ok\":true}")));
        api.Start();
        return (api, new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") });
    }

    static async Task<string?> Login(HttpClient h, string code)
    {
        var r = await h.PostAsync("/api/login", new StringContent("{\"Code\":\"" + code + "\"}"));
        if (!r.IsSuccessStatusCode) return null;
        return (await r.Content.ReadFromJsonAsync<ApiLoginResult>())!.Token;
    }

    static async Task<HttpStatusCode> Get(HttpClient h, string? token)
    {
        var rq = new HttpRequestMessage(HttpMethod.Get, "/api/state");
        if (token != null) rq.Headers.Authorization = new("Bearer", token);
        return (await h.SendAsync(rq)).StatusCode;
    }

    [Fact]
    public async Task Code_is_not_a_bearer_token_but_login_gives_a_working_session()
    {
        var (api, h) = Start("12345678"); using (api)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await Get(h, "12345678"));   // mã kết nối không dùng trực tiếp được
            Assert.Equal(HttpStatusCode.Unauthorized, await Get(h, null));
            var t = await Login(h, "12345678");
            Assert.NotNull(t);
            Assert.Equal(HttpStatusCode.OK, await Get(h, t));
            Assert.Null(await Login(h, "00000000"));
        }
    }

    [Fact]
    public async Task Rotating_code_keeps_sessions_rejects_old_code_after_grace_and_accepts_new()
    {
        var (api, h) = Start("11111111"); using (api)
        {
            var t = await Login(h, "11111111");
            api.Rotate("22222222");
            Assert.Equal(HttpStatusCode.OK, await Get(h, t));                      // phiên đang nối không bị ngắt khi mã đổi
            Assert.NotNull(await Login(h, "22222222"));                            // mã mới dùng được ngay
            Assert.NotNull(await Login(h, "11111111"));                            // mã cũ còn trong thời gian ân hạn 5 giây
            api.Rotate("33333333");                                                // đổi lần nữa: mã đầu tiên đã quá cũ
            Assert.Null(await Login(h, "11111111"));
            Assert.Equal(HttpStatusCode.OK, await Get(h, t));
        }
    }

    [Fact]
    public async Task Five_wrong_codes_lock_login_but_not_existing_sessions()
    {
        var (api, h) = Start("12345678"); using (api)
        {
            var t = await Login(h, "12345678");
            for (var i = 0; i < 5; i++) Assert.Null(await Login(h, "99999999"));
            var r = await h.PostAsync("/api/login", new StringContent("{\"Code\":\"12345678\"}"));
            Assert.Equal((HttpStatusCode)429, r.StatusCode);                        // đang khoá: cả mã đúng cũng bị từ chối
            Assert.Equal(HttpStatusCode.OK, await Get(h, t));                       // phiên cũ vẫn dùng được
            Assert.Equal(HttpStatusCode.Unauthorized, await Get(h, "sai-phien"));   // mã phiên sai không làm tăng bộ đếm khoá
        }
    }
}
