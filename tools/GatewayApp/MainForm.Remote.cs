using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// API cho tool admin (nối bằng IP): xem trạng thái/giá trị, tải và đẩy cấu hình, ghi lệnh điều khiển, chạy/dừng.
///   --customer            bản của khách: ẩn các trang thiết lập
///   (trang "Kết nối admin")  bật/tắt cho admin cài đặt, hiện mã kết nối 8 chữ số; mặc định TẮT
///   --api                 bật ngay lúc mở (kiểm thử)
///   --api-port N          cổng (mặc định 8750)
///   --bind 0.0.0.0        cho phép máy khác trong LAN (cũng đổi được ở trang "Kết nối admin")
///   --token X             mã cố định thay cho mã ngẫu nhiên (kiểm thử)
/// </summary>
public sealed partial class MainForm
{
    RemoteApi? _api;
    int _rev;
    bool _apiOn, _apiLan;
    string _code = "", _fixedCode = "";
    int _apiPort = 8750;
    DateTime _codeAt;
    const int CodeLifeSec = 60;
    readonly System.Windows.Forms.Timer _codeTimer = new() { Interval = 500 };

    static string NewCode() => RandomNumberGenerator.GetInt32(10_000_000, 100_000_000).ToString();

    /// <summary>Mỗi 60 giây tự đổi mã kết nối (trừ mã cố định --token) và cập nhật đếm lùi trên trang Kết nối admin.</summary>
    void CodeTick()
    {
        if (!_apiOn || _api == null) { _codeTimer.Stop(); return; }
        if (_fixedCode.Length == 0)
        {
            var left = CodeLifeSec - (int)(DateTime.UtcNow - _codeAt).TotalSeconds;
            if (left <= 0) { _code = NewCode(); _codeAt = DateTime.UtcNow; _api.Rotate(_code); RefreshAccessPage(); left = CodeLifeSec; }
            _access.SetCountdown(left);
        }
    }
    static readonly JsonSerializerOptions J = new() { PropertyNameCaseInsensitive = true };

    static string ArgValue(string[] a, string name) { var i = Array.IndexOf(a, name); return i >= 0 && i + 1 < a.Length ? a[i + 1] : ""; }

    /// <summary>Mặc định TẮT: người dùng bật ở trang "Kết nối admin" khi cần cài đặt. --api hoặc --token bật ngay lúc mở (kiểm thử).</summary>
    void InitRemoteAccess(string[] args)
    {
        _apiPort = int.TryParse(ArgValue(args, "--api-port"), out var p) ? p : 8750;
        _fixedCode = ArgValue(args, "--token");
        _apiLan = IPAddress.TryParse(ArgValue(args, "--bind"), out var ip) && !IPAddress.IsLoopback(ip);
        _codeTimer.Tick += (_, _) => CodeTick();
        _access.EnabledChanged += on => SetAccess(on);
        _access.LanChanged += lan => { _apiLan = lan; if (_apiOn) SetAccess(true); else RefreshAccessPage(); };
        _access.NewCodeRequested += () => SetAccess(true, true);
        if (args.Contains("--api") || _fixedCode.Length > 0) SetAccess(true); else RefreshAccessPage();
    }

    void SetAccess(bool on, bool newCode = false)
    {
        var keep = _apiOn && !newCode;
        _api?.Dispose(); _api = null; _apiOn = false;
        if (on)
        {
            if (!keep || _code.Length == 0) _code = _fixedCode.Length > 0 ? _fixedCode : NewCode();
            _codeAt = DateTime.UtcNow;
            try
            {
                _api = new RemoteApi(_apiLan ? IPAddress.Any : IPAddress.Loopback, _apiPort, _code, HandleApi);
                _api.Start(); _apiOn = true; _codeTimer.Start();
                _log.Add("INFO", "api", $"Đã BẬT cho admin cài đặt: {(_apiLan ? "mọi địa chỉ" : "127.0.0.1")}:{_apiPort}");
                Toast(newCode ? "Đã tạo mã kết nối mới." : "Đã bật cho admin cài đặt.");
            }
            catch (Exception e) { _api?.Dispose(); _api = null; _code = ""; Toast("Không mở được cổng cho tool admin: " + e.Message, true); }
        }
        else { _code = ""; _log.Add("INFO", "api", "Đã TẮT cho admin cài đặt"); Toast("Đã tắt cho admin cài đặt."); }
        RefreshAccessPage();
    }

    void RefreshAccessPage()
    {
        var ips = new List<string> { "127.0.0.1" };
        if (_apiLan)
        {
            try { ips.AddRange(Dns.GetHostEntry(Dns.GetHostName()).AddressList.Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)).Select(a => a.ToString())); }
            catch (Exception) { /* không lấy được danh sách IP */ }
        }
        _access.Show(_apiOn, _apiLan, _code, _apiPort, ips.ToArray(), _fixedCode.Length == 0);
        if (_apiOn && _fixedCode.Length == 0) _access.SetCountdown(Math.Max(0, CodeLifeSec - (int)(DateTime.UtcNow - _codeAt).TotalSeconds));
    }

    Task<T> OnUi<T>(Func<Task<T>> f)
    {
        var tcs = new TaskCompletionSource<T>();
        BeginInvoke(async () => { try { tcs.SetResult(await f()); } catch (Exception e) { tcs.SetException(e); } });
        return tcs.Task;
    }

    static string Json(object o) => JsonSerializer.Serialize(o);
    static (int, string) Ok(bool running) => (200, Json(new ApiResult { Ok = true, Running = running }));
    static (int, string) Err(string e, int status = 400) => (status, Json(new ApiResult { Ok = false, Err = e }));

    async Task<(int, string)> HandleApi(string method, string path, string body)
    {
        try
        {
            var route = method.ToUpperInvariant() + " " + path.Split('?')[0];
            switch (route)
            {
                case "GET /api/state": return await OnUi(() => Task.FromResult((200, Json(StateModel()))));
                case "GET /api/config": return await OnUi(() => Task.FromResult((200, Json(ConfigModel()))));
                case "PUT /api/config": return await OnUi(() => ApplyRemoteAsync(body));
                case "POST /api/write":
                {
                    var w = JsonSerializer.Deserialize<ApiWrite>(body, J);
                    if (w == null || w.Child.Length == 0 || w.Field.Length == 0) return Err("bad_request");
                    var err = await OnUi(() => WriteAsync(w.Child, w.Field, w.Value));
                    return err == null ? Ok(Running) : Err(err);
                }
                case "POST /api/run":
                {
                    var r = JsonSerializer.Deserialize<ApiRun>(body, J);
                    if (r == null) return Err("bad_request");
                    await OnUi(async () => { if (r.Run) await StartAsync(); else await StopAsync(); return 0; });
                    return Ok(Running);
                }
                case "POST /api/device":
                {
                    var d = JsonSerializer.Deserialize<ApiDevice>(body, J);
                    if (d == null || d.Child.Length == 0) return Err("bad_request");
                    var err = await OnUi(() => SetDeviceEnabledAsync(d.Child, d.Enabled));
                    return err == null ? Ok(Running) : Err(err);
                }
                case "POST /api/cloud":
                {
                    var c = JsonSerializer.Deserialize<ApiCloud>(body, J);
                    if (c == null || c.Action.Length == 0) return Err("bad_request");
                    var r = await OnUi(() => CloudAsync(c.Action, c.Api, c.Value));
                    return (200, Json(new ApiResult { Ok = r.Ok, Err = r.Ok ? null : r.Msg, Msg = r.Msg, Running = Running }));
                }
                default: return Err("not_found", 404);
            }
        }
        catch (JsonException) { return Err("bad_json"); }
        catch (Exception e) { return Err(e.Message, 500); }
    }

    ApiState StateModel() => new()
    {
        Running = _host != null,
        Status = _host != null ? _host.Core.State.Status : "đã dừng",
        Cloud = (_host?.Cloud ?? CloudState.Disabled).ToString(),
        Rev = _rev, Customer = _customer, Fingerprint = FingerprintText,
        Values = _values.ToDictionary(kv => kv.Key, kv => kv.Value),
    };

    ApiConfig ConfigModel()
    {
        var clone = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(_cfg))!;
        clone.CloudPassword = ""; clone.WebCertPassword = "";
        foreach (var u in clone.LocalUsers) u.Password = "";
        return new ApiConfig { Config = clone, Fields = new(_meta.Map), Devices = new(_meta.Devices) };
    }

    async Task<(int, string)> ApplyRemoteAsync(string body)
    {
        var inc = JsonSerializer.Deserialize<ApiConfig>(body, J);
        if (inc == null) return Err("bad_request");
        // mật khẩu để trống = giữ mật khẩu hiện có (gateway không gửi mật khẩu về tool)
        if (string.IsNullOrEmpty(inc.Config.CloudPassword)) inc.Config.CloudPassword = _cfg.CloudPassword;
        if (string.IsNullOrEmpty(inc.Config.WebCertPassword)) inc.Config.WebCertPassword = _cfg.WebCertPassword;
        foreach (var u in inc.Config.LocalUsers.Where(u => string.IsNullOrEmpty(u.Password)))
            u.Password = _cfg.LocalUsers.FirstOrDefault(x => x.User == u.User)?.Password ?? "";
        var err = inc.Config.Validate();
        if (err != null) return Err(err);
        CopyFrom(inc.Config);
        _meta.Replace(inc.Fields, inc.Devices);
        await ApplyAsync("Quản trị viên đã cập nhật cấu hình gateway");
        _dash.Rebuild();
        return Ok(Running);
    }
}
