using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Plciot.Scada;

/// <summary>
/// MÀN HÌNH PHỤ (client của topology nhiều màn hình): nối tới máy chính bằng tài khoản monitor/operator, nhận trạng thái theo thời gian
/// thực (SSE). Cài đặt <see cref="IScadaView"/> nên cùng một giao diện dùng được ở máy chính lẫn máy phụ.
/// <see cref="CanControl"/> do MÁY CHỦ quyết định (chính sách <c>Control.RemoteScreens</c> + vai trò tài khoản); lệnh ghi đi qua máy chủ
/// và bị kiểm tra lại ở đó — client không thể tự cấp quyền cho mình.
/// </summary>
public sealed class RemoteScreenClient : IScadaView, IAsyncDisposable
{
    readonly Uri _server;
    readonly string _user, _password;
    readonly HttpClient _http;
    readonly CookieContainer _jar = new();
    readonly DeviceState _state = new();
    readonly Queue<string> _log = new();
    readonly CancellationTokenSource _cts = new();
    Task? _loop;
    volatile string _info = "Đang nối…";
    volatile string _site = "", _device = "";
    DeviceState.Snapshot _snap = new(new ushort[Contract.TelemetryRegs], "offline", null, null, null);

    public RemoteScreenClient(string serverUrl, string user, string password, HttpMessageHandler? handler = null)
    {
        _server = new Uri(serverUrl.TrimEnd('/') + "/");
        _user = user; _password = password;
        _http = handler != null ? new HttpClient(handler) : new HttpClient(new HttpClientHandler { CookieContainer = _jar, UseCookies = true });
        _http.Timeout = Timeout.InfiniteTimeSpan;
        _http.DefaultRequestHeaders.Add("X-Requested-With", "scada");
    }

    public string Site => _site;
    public string Device => _device;
    volatile bool _canControl;
    public bool CanControl => _canControl;
    public string InfoLine => _info;
    public DeviceState.Snapshot State => _snap;
    public string[] RecentLog { get { lock (_log) return _log.ToArray(); } }
    public bool Connected { get; private set; }
    public event Action<string>? Log;

    public void Start() => _loop = Task.Run(RunAsync);

    void Emit(string s)
    {
        var line = $"{DateTime.Now:HH:mm:ss} {s}";
        lock (_log) { _log.Enqueue(line); while (_log.Count > 200) _log.Dequeue(); }
        Log?.Invoke(line);
    }

    public async Task<string?> WriteAsync(int address, int value, string actor = "ui", CancellationToken ct = default)
    {
        if (!Connected) return "not_connected";
        if (!_canControl) return "monitor_only";
        try
        {
            using var r = await _http.PostAsJsonAsync(new Uri(_server, "api/cmd"), new { a = address, v = value }, ct);
            if (r.IsSuccessStatusCode) return null;
            var j = await r.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct);
            return j.TryGetProperty("error", out var e) ? e.GetString() : $"http_{(int)r.StatusCode}";
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException) { return "network_error"; }
    }

    async Task RunAsync()
    {
        var delay = TimeSpan.FromSeconds(2);
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                _info = $"Đang nối {_server.Host}…";
                using (var r = await _http.PostAsJsonAsync(new Uri(_server, "api/login"), new { user = _user, password = _password }, _cts.Token))
                {
                    if (!r.IsSuccessStatusCode) throw new HttpRequestException(r.StatusCode == HttpStatusCode.Unauthorized ? "sai tài khoản/mật khẩu" : $"HTTP {(int)r.StatusCode}");
                }
                using var req = new HttpRequestMessage(HttpMethod.Get, new Uri(_server, "api/events"));
                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token);
                resp.EnsureSuccessStatusCode();
                using var sr = new StreamReader(await resp.Content.ReadAsStreamAsync(_cts.Token));
                Connected = true;
                Emit($"Đã nối máy chính {_server.Host}:{_server.Port}");
                delay = TimeSpan.FromSeconds(2);
                string? line;
                while ((line = await sr.ReadLineAsync(_cts.Token)) != null)
                {
                    if (line.StartsWith("data: ", StringComparison.Ordinal)) Apply(line[6..]);
                }
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested) { break; }
            catch (Exception ex) { Emit($"Mất kết nối máy SCADA: {ex.Message}"); }
            Connected = false;
            _info = "Mất kết nối, đang thử lại…";
            _snap = _snap with { Status = "offline", TelemetryAt = null };
            try { await Task.Delay(delay, _cts.Token); } catch (OperationCanceledException) { break; }
            delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 15));
        }
    }

    void Apply(string json)
    {
        try
        {
            using var d = JsonDocument.Parse(json);
            var e = d.RootElement;
            var regs = new ushort[Contract.TelemetryRegs];
            var i = 0;
            foreach (var v in e.GetProperty("regs").EnumerateArray()) { if (i >= regs.Length) break; regs[i++] = (ushort)v.GetInt32(); }
            DeviceState.HistoryBlock? h = null;
            if (e.TryGetProperty("history", out var hj) && hj.ValueKind == JsonValueKind.Object)
            {
                int[] arr(string n) => hj.GetProperty(n).EnumerateArray().Select(x => x.GetInt32()).ToArray();
                h = new DeviceState.HistoryBlock(arr("c"), hj.GetProperty("s").GetInt32(), hj.GetProperty("n").GetInt32(),
                    hj.TryGetProperty("r", out var rr) ? rr.GetInt32() : 0, arr("m"));
            }
            var age = e.TryGetProperty("telemetryAgeMs", out var a) ? a.GetInt64() : -1;
            _site = e.GetProperty("site").GetString() ?? ""; _device = e.GetProperty("device").GetString() ?? "";
            _snap = new DeviceState.Snapshot(regs, e.GetProperty("status").GetString() ?? "offline",
                age >= 0 ? DateTime.UtcNow.AddMilliseconds(-age) : null, h, e.TryGetProperty("lastAck", out var la) ? la.GetString() : null);
            _canControl = e.TryGetProperty("canControl", out var cc) && cc.GetBoolean();
            var cloud = e.TryGetProperty("cloud", out var c) ? c.GetString() : "";
            _info = $"Màn hình phụ ↔ {_server.Host}:{_server.Port} · {(_canControl ? "được điều khiển" : "chỉ xem")} · cloud {cloud}";
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            // gói hỏng: bỏ qua
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop != null) { try { await _loop.WaitAsync(TimeSpan.FromSeconds(3)); } catch { /* ignore */ } }
        _http.Dispose();
    }
}
