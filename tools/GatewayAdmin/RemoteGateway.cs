using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using GatewayApp;
using Plciot.Scada;

namespace GatewayAdmin;

/// <summary>Gateway ở xa (nối bằng IP): cùng giao diện IGatewayApp nên các trang Tổng quan/Thiết bị/Giao thức dùng lại nguyên vẹn.</summary>
public sealed class RemoteGateway : IGatewayApp
{
    static readonly JsonSerializerOptions J = new() { PropertyNameCaseInsensitive = true };
    HttpClient? _http;
    readonly ConcurrentDictionary<string, double> _values = new();
    int _rev = -1;
    bool _busy;

    public ScadaConfig Config { get; private set; } = new();
    public UiMetaStore Meta { get; } = new(Path.Combine(Path.GetTempPath(), "gatewayadmin-ui.json")) { Persist = false };
    public HistoryStore History { get; } = new();
    public bool Running { get; private set; }
    public bool Connected => _http != null;
    public string Status { get; private set; } = "";
    public string Cloud { get; private set; } = "";
    public string FingerprintText { get; private set; } = "";
    public bool TryValue(string key, out double v) => _values.TryGetValue(key, out v);
    public event Action<string, bool>? ToastRaised;
    public void Toast(string text, bool error = false) => ToastRaised?.Invoke(text, error);

    public async Task ConnectAsync(string address, string token)
    {
        Disconnect();
        var uri = new Uri(address.Contains("://") ? address : "http://" + address);
        var http = new HttpClient { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(10) };
        _http = http;
        try
        {
            // mã kết nối đổi mỗi phút → đổi lấy mã phiên một lần, các yêu cầu sau dùng mã phiên
            var login = await ReadAsync<ApiLoginResult>(await http.PostAsync("/api/login", Body(new ApiLogin { Code = token })));
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.Token);
            await ReloadConfigAsync(); await PollAsync();
        }
        catch { Disconnect(); throw; }
    }

    public void Disconnect()
    {
        _http?.Dispose(); _http = null; Running = false; Status = ""; _values.Clear(); _rev = -1;
        // bỏ cấu hình đã tải: không cho sửa dữ liệu cũ của một gateway đã mất kết nối (thay đổi sẽ không được gửi đi)
        Config = new(); Meta.Replace(new(), new());
    }

    // Gửi kèm Content-Length (không dùng chunked): API của gateway tự viết, không đọc được thân chunked.
    static StringContent Body(object o) => new(JsonSerializer.Serialize(o), System.Text.Encoding.UTF8, "application/json");

    static async Task<T> ReadAsync<T>(HttpResponseMessage r)
    {
        if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized) throw new InvalidOperationException("Sai mã kết nối.");
        var s = await r.Content.ReadAsStringAsync();
        if (r.StatusCode == (System.Net.HttpStatusCode)429) throw new InvalidOperationException("Nhập sai mã quá nhiều lần — chờ 1 phút rồi thử lại.");
        if (!r.IsSuccessStatusCode)
        {
            string? err = null; try { err = JsonSerializer.Deserialize<ApiResult>(s, J)?.Err; } catch (JsonException) { }
            throw new InvalidOperationException(err ?? $"HTTP {(int)r.StatusCode}");
        }
        return JsonSerializer.Deserialize<T>(s, J) ?? throw new InvalidOperationException("phản hồi rỗng");
    }

    public async Task ReloadConfigAsync()
    {
        var c = await ReadAsync<ApiConfig>(await _http!.GetAsync("/api/config"));
        Config = c.Config;
        Meta.Replace(c.Fields, c.Devices);
    }

    /// <summary>Hỏi trạng thái + giá trị mới nhất. Gateway đổi cấu hình (do admin khác) thì tải lại. Trả về false nếu mất kết nối.</summary>
    public async Task<bool> PollAsync()
    {
        if (_http == null || _busy) return _http != null;
        _busy = true;
        try
        {
            var s = await ReadAsync<ApiState>(await _http.GetAsync("/api/state"));
            Running = s.Running; Status = s.Status; Cloud = s.Cloud; FingerprintText = s.Fingerprint;
            _values.Clear();
            foreach (var kv in s.Values) { _values[kv.Key] = kv.Value; History.Add(kv.Key, kv.Value); }
            if (_rev >= 0 && s.Rev != _rev) await ReloadConfigAsync();
            _rev = s.Rev;
            return true;
        }
        catch (Exception) { return false; }
        finally { _busy = false; }
    }

    public async Task<string?> WriteAsync(string child, string field, double value)
    {
        if (_http == null) return "chưa kết nối gateway";
        try
        {
            var r = await ReadAsync<ApiResult>(await _http.PostAsync("/api/write", Body(new ApiWrite { Child = child, Field = field, Value = value })));
            return r.Ok ? null : r.Err ?? "lỗi";
        }
        catch (Exception e) { return e.Message; }
    }

    public async Task<(bool Ok, string Msg)> CloudAsync(string action, string api, string value)
    {
        if (_http == null) return (false, "chưa kết nối gateway");
        try
        {
            var r = await ReadAsync<ApiResult>(await _http.PostAsync("/api/cloud", Body(new ApiCloud { Action = action, Api = api, Value = value })));
            return (r.Ok, r.Msg ?? r.Err ?? (r.Ok ? "xong" : "lỗi"));
        }
        catch (Exception e) { return (false, e.Message); }
    }

    public async Task<string?> SetDeviceEnabledAsync(string child, bool enabled)
    {
        if (_http == null) return "chưa kết nối gateway";
        try
        {
            var r = await ReadAsync<ApiResult>(await _http.PostAsync("/api/device", Body(new ApiDevice { Child = child, Enabled = enabled })));
            if (!r.Ok) return r.Err ?? "lỗi";
            foreach (var p in Config.Pack.Where(x => x.Child == child)) p.Enabled = enabled;
            if (!enabled) foreach (var k in _values.Keys.Where(k => k.StartsWith(child + ".")).ToList()) _values.TryRemove(k, out _);
            return null;
        }
        catch (Exception e) { return e.Message; }
    }

    /// <summary>Đẩy cấu hình hiện tại (thiết bị, giao thức, hiển thị) sang gateway; gateway lưu rồi tự khởi động lại luồng đọc.</summary>
    public async Task ApplyAsync(string why)
    {
        if (_http == null) { Toast("Chưa kết nối gateway — thay đổi chưa được gửi.", true); return; }
        try
        {
            var body = new ApiConfig { Config = Config, Fields = Meta.Map, Devices = Meta.Devices };
            var r = await ReadAsync<ApiResult>(await _http.PutAsync("/api/config", Body(body)));
            _rev = -1;   // lần poll sau nhận Rev mới, không tải lại thừa
            await ReloadConfigAsync();
            Toast(why + " → đã gửi sang gateway" + (r.Running ? "" : " (gateway chưa chạy)"));
        }
        catch (Exception e) { Toast("Gateway từ chối cấu hình: " + e.Message, true); try { await ReloadConfigAsync(); } catch (Exception) { } }
    }
}
