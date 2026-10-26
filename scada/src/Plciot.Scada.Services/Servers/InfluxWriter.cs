using System.Globalization;
using System.Net.Http.Headers;
using System.Text;

namespace Plciot.Scada;

/// <summary>
/// Ghi chuỗi thời gian vào InfluxDB 2 (line protocol qua HTTP) cho Grafana. CÙNG sơ đồ và kiểu dữ liệu với luồng Node-RED
/// (measurement plc / plc_status, tag site+device, mọi trường là float) để hai phần mềm dùng chung một bucket được.
/// </summary>
public sealed class InfluxWriter : IAsyncDisposable
{
    readonly ScadaConfig _cfg;
    readonly Func<DeviceState.Snapshot> _state;
    readonly HttpClient _http;
    readonly CancellationTokenSource _cts = new();
    Task? _loop;
    int _failures;

    public event Action<string>? Log;

    public InfluxWriter(ScadaConfig cfg, Func<DeviceState.Snapshot> state, HttpMessageHandler? handler = null)
    {
        _cfg = cfg;
        _state = state;
        _http = handler != null ? new HttpClient(handler) : new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(10);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Token", cfg.InfluxToken);
    }

    public void Start() => _loop = Task.Run(RunAsync);

    async Task RunAsync()
    {
        var every = TimeSpan.FromSeconds(Math.Max(1, _cfg.InfluxEverySec));
        while (!_cts.IsCancellationRequested)
        {
            try { await Task.Delay(every, _cts.Token); } catch (OperationCanceledException) { return; }
            try
            {
                var body = BuildLines(_state(), DateTimeOffset.UtcNow);
                await WriteAsync(body, _cts.Token);
                _failures = 0;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (++_failures == 1 || _failures % 30 == 0) Log?.Invoke($"InfluxDB: {ex.Message}");
            }
        }
    }

    public async Task WriteAsync(string lines, CancellationToken ct)
    {
        var url = $"{_cfg.InfluxUrl.TrimEnd('/')}/api/v2/write?org={Uri.EscapeDataString(_cfg.InfluxOrg)}&bucket={Uri.EscapeDataString(_cfg.InfluxBucket)}&precision=ms";
        using var resp = await _http.PostAsync(url, new StringContent(lines, Encoding.UTF8, "text/plain"), ct);
        if (!resp.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)resp.StatusCode}: {(await resp.Content.ReadAsStringAsync(ct)).Trim()}");
    }

    static string Esc(string s) => s.Replace("\\", "\\\\").Replace(",", "\\,").Replace(" ", "\\ ").Replace("=", "\\=");
    static string F(double v) => v.ToString("0.###############", CultureInfo.InvariantCulture);   // float, không hậu tố i

    /// <summary>Hai dòng như luồng Node-RED: plc_status luôn có; plc chỉ khi PLC còn liên lạc.</summary>
    public string BuildLines(DeviceState.Snapshot s, DateTimeOffset now)
    {
        var tags = $"site={Esc(_cfg.Site)},device={Esc(_cfg.Device)}";
        var ts = now.ToUnixTimeMilliseconds();
        var online = s.Fresh && s.Status == "online" ? 1 : 0;
        var sb = new StringBuilder();
        sb.Append($"plc_status,{tags} online={F(online)} {ts}\n");
        if (s.Fresh)
        {
            var f = new List<(string, double)>
            {
                ("inputs", s.Inputs), ("outputs", s.Outputs), ("alarms", s.Alarms), ("mode", s.Manual ? 1 : 0), ("run_req", s.RunRequested ? 1 : 0),
                ("target", s.Target), ("conveyor", s.Conveyor), ("count", s.Count), ("total", s.Total), ("run_s", s.RunSeconds), ("pump_starts", s.PumpStarts),
                ("estop", s.Estop ? 1 : 0), ("level_fault", s.LevelFault ? 1 : 0),
            };
            for (var i = 0; i < 8; i++) { f.Add(($"x{i}", s.Inputs >> i & 1)); f.Add(($"y{i}", s.Outputs >> i & 1)); }
            sb.Append($"plc,{tags} {string.Join(',', f.Select(x => $"{x.Item1}={F(x.Item2)}"))} {ts}\n");
        }
        return sb.ToString();
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop != null) { try { await _loop; } catch { /* ignore */ } }
        _http.Dispose();
    }
}
