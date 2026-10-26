using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Plciot.Scada;

/// <summary>
/// Giao diện web cục bộ, cùng chức năng với ứng dụng WPF: nhiều màn hình trong nhà máy đăng nhập bằng trình duyệt
/// (tài khoản LocalUsers vai trò Monitor = chỉ xem, Operator = xem + điều khiển).
/// Cookie phiên HttpOnly + SameSite=Strict, yêu cầu header X-Requested-With cho thao tác ghi, giới hạn đăng nhập sai theo IP.
/// </summary>
public sealed class LocalWebServer : IAsyncDisposable
{
    sealed record Session(string User, LocalRole Role, DateTime Expires);

    const string Cookie = "scada_sid";
    static readonly TimeSpan SessionTtl = TimeSpan.FromHours(12);

    readonly ScadaConfig _cfg;
    readonly ScadaHost _host;
    readonly ConcurrentDictionary<string, Session> _sessions = new();
    readonly ConcurrentDictionary<string, (int Fails, DateTime Until)> _fails = new();
    WebApplication? _app;

    public int Port { get; private set; }

    public LocalWebServer(ScadaConfig cfg, ScadaHost host)
    {
        _cfg = cfg;
        _host = host;
    }

    public async Task StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(k =>
        {
            k.AddServerHeader = false;
            k.Limits.MaxRequestBodySize = 4096;
            k.Limits.MaxConcurrentConnections = 100;
            var ip = IPAddress.Parse(_cfg.WebBind);
            k.Listen(ip, _cfg.WebPort, lo =>
            {
                if (!string.IsNullOrWhiteSpace(_cfg.WebCertPath))
                    lo.UseHttps(new X509Certificate2(_cfg.WebCertPath, _cfg.WebCertPassword));
            });
        });
        var app = builder.Build();
        Map(app);
        await app.StartAsync();
        Port = new Uri(app.Urls.First().Replace("[::]", "localhost").Replace("0.0.0.0", "localhost")).Port;
        _app = app;
    }

    static string Resource(string name)
    {
        var asm = typeof(LocalWebServer).Assembly;
        var res = asm.GetManifestResourceNames().First(n => n.EndsWith(name, StringComparison.Ordinal));
        using var s = asm.GetManifestResourceStream(res)!;
        using var r = new StreamReader(s, Encoding.UTF8);
        return r.ReadToEnd();
    }

    void Map(WebApplication app)
    {
        var page = Resource("index.html");
        var js = Resource("app.js");
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        app.Use(async (ctx, next) =>
        {
            var h = ctx.Response.Headers;
            h["X-Content-Type-Options"] = "nosniff";
            h["X-Frame-Options"] = "DENY";
            h["Referrer-Policy"] = "no-referrer";
            h["Cache-Control"] = "no-store";
            h["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
            await next();
        });

        app.MapGet("/", () => Results.Text(page, "text/html; charset=utf-8"));
        app.MapGet("/app.js", () => Results.Text(js, "text/javascript; charset=utf-8"));

        app.MapPost("/api/login", async (HttpContext ctx) =>
        {
            if (!IsAjax(ctx)) return Results.StatusCode(400);
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "?";
            if (_fails.TryGetValue(ip, out var f) && f.Fails >= 5 && f.Until > DateTime.UtcNow)
                return Results.Json(new { error = "rate_limited" }, statusCode: 429);
            LoginBody? b;
            try { b = await ctx.Request.ReadFromJsonAsync<LoginBody>(json); } catch (JsonException) { return Results.StatusCode(400); }
            var u = _cfg.LocalUsers.FirstOrDefault(x => x.User == b?.User && x.Role != LocalRole.Device && x.Password.Length > 0);
            var ok = u != null && FixedEquals(u.Password, b!.Password ?? "");
            if (!ok)
            {
                _fails.AddOrUpdate(ip, _ => (1, DateTime.UtcNow.AddMinutes(5)), (_, o) => (o.Fails + 1, DateTime.UtcNow.AddMinutes(5)));
                await Task.Delay(400);          // làm chậm dò mật khẩu
                return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            }
            _fails.TryRemove(ip, out _);
            var sid = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
            _sessions[sid] = new Session(u!.User, u.Role, DateTime.UtcNow + SessionTtl);
            ctx.Response.Cookies.Append(Cookie, sid, new CookieOptions
            {
                HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = ctx.Request.IsHttps, MaxAge = SessionTtl, Path = "/",
            });
            return Results.Json(new { user = u.User, role = u.Role.ToString().ToLowerInvariant() });
        });

        app.MapPost("/api/logout", (HttpContext ctx) =>
        {
            if (ctx.Request.Cookies.TryGetValue(Cookie, out var sid)) _sessions.TryRemove(sid, out _);
            ctx.Response.Cookies.Delete(Cookie);
            return Results.Ok();
        });

        app.MapGet("/api/state", (HttpContext ctx) =>
            Auth(ctx) is { } s ? Results.Json(Snapshot(s), json) : Results.StatusCode(401));

        app.MapGet("/api/log", (HttpContext ctx) =>
            Auth(ctx) is null ? Results.StatusCode(401) : Results.Json(_host.Core.RecentLog));

        app.MapGet("/api/events", async (HttpContext ctx) =>
        {
            var s = Auth(ctx);
            if (s is null) { ctx.Response.StatusCode = 401; return; }
            ctx.Response.ContentType = "text/event-stream";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            var ct = ctx.RequestAborted;
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    if (Auth(ctx) is null) return;       // phiên hết hạn/đăng xuất → cắt luồng
                    await ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(Snapshot(s), json)}\n\n", ct);
                    await ctx.Response.Body.FlushAsync(ct);
                    await Task.Delay(500, ct);
                }
            }
            catch (OperationCanceledException) { /* client đóng */ }
        });

        app.MapPost("/api/cmd", async (HttpContext ctx) =>
        {
            if (!IsAjax(ctx)) return Results.StatusCode(400);
            var s = Auth(ctx);
            if (s is null) return Results.StatusCode(401);
            if (!_cfg.AllowsControl(ControlSource.RemoteScreen)) return Results.Json(new { error = "monitor_only" }, statusCode: 403);   // chính sách: màn hình phụ chỉ GIÁM SÁT
            if (s.Role != LocalRole.Operator) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            CmdBody? b;
            try { b = await ctx.Request.ReadFromJsonAsync<CmdBody>(json); } catch (JsonException) { return Results.StatusCode(400); }
            if (b is null) return Results.StatusCode(400);
            var err = await _host.Core.WriteAsync(b.A, b.V, ControlSource.RemoteScreen, "web:" + s.User);
            return err == null ? Results.Json(new { ok = true }) : Results.Json(new { error = err }, statusCode: 400);
        });
    }

    static bool IsAjax(HttpContext ctx) => ctx.Request.Headers["X-Requested-With"] == "scada";

    static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));

    Session? Auth(HttpContext ctx)
    {
        if (!ctx.Request.Cookies.TryGetValue(Cookie, out var sid) || !_sessions.TryGetValue(sid, out var s)) return null;
        if (s.Expires < DateTime.UtcNow) { _sessions.TryRemove(sid, out _); return null; }
        return s;
    }

    object Snapshot(Session s)
    {
        var st = _host.Core.State;
        return new
        {
            user = s.User,
            role = s.Role.ToString().ToLowerInvariant(),
            site = _cfg.Site,
            device = _cfg.Device,
            status = st.Status,
            fresh = st.Fresh,
            regs = st.Regs,
            inputs = st.Inputs,
            outputs = st.Outputs,
            alarms = st.Alarms,
            manual = st.Manual,
            manualMask = st.ManualMask,
            runRequested = st.RunRequested,
            target = st.Target,
            conveyor = st.Conveyor,
            conveyorText = st.ConveyorText,
            count = st.Count,
            total = st.Total,
            runSeconds = st.RunSeconds,
            pumpStarts = st.PumpStarts,
            history = st.History is { } h ? new { c = h.Counts, m = h.RunMinutes, s = h.Seconds, n = h.Hours, r = h.RunSeconds } : null,
            telemetryAgeMs = st.TelemetryAt is { } ta ? (long)(DateTime.UtcNow - ta).TotalMilliseconds : -1L,
            canControl = _cfg.AllowsControl(ControlSource.RemoteScreen) && s.Role == LocalRole.Operator,
            lastAck = st.LastAck,
            cloud = _host.Cloud.ToString().ToLowerInvariant(),
            localClients = _host.LocalClients,
            remoteAllowed = _cfg.AllowRemoteControl,
            mobile = _cfg.Mobile.ToString().ToLowerInvariant(),
        };
    }

    sealed record LoginBody(string? User, string? Password);
    sealed record CmdBody(int A, int V);

    public async ValueTask DisposeAsync()
    {
        if (_app != null) { await _app.StopAsync(); await _app.DisposeAsync(); }
    }
}
