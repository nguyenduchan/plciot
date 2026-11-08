using System.Text;

namespace Plciot.Scada;

/// <summary>
/// Gốc ghép nối ("composition root") dùng bởi ứng dụng/Host: tạo <see cref="ScadaCore"/> rồi gắn các dịch vụ tuỳ chọn theo cấu hình.
/// Điều khiển tại máy đi thẳng <see cref="Core"/> → driver PLC. Các dịch vụ dưới đây chỉ phục vụ nhu cầu khác:
///   • broker LAN (gateway ESP32 / HMI MQTT)   • cầu nối TLS lên cloud (điện thoại)   • web + máy khách giám sát từ xa (CHỈ XEM)
///   • server Modbus TCP / OPC UA (CHỈ ĐỌC)     • ghi InfluxDB cho Grafana
/// Giao diện của khách hàng có thể bỏ qua lớp này và dùng thẳng <see cref="ScadaCore"/>.
/// </summary>
public sealed class ScadaHost : IAsyncDisposable
{
    public const string CoreSender = LocalBroker.InternalPrefix + "core";
    public const string CloudSender = LocalBroker.InternalPrefix + "cloud";

    readonly ScadaConfig _cfg;
    readonly CloudBridge _bridge;
    readonly object _rate = new();
    readonly Dictionary<string, long> _seenCmdIds = new();       // id lệnh đã xử lý → thời điểm (ms): chặn phát lại
    const int SeenCmdWindowMs = 5 * 60_000, SeenCmdMax = 512;
    long _rateSec;
    int _rateCount;
    LocalBroker? _broker;
    LocalWebServer? _web;
    ModbusTcpServer? _mbServer;
    OpcUaServerHost? _uaServer;
    InfluxWriter? _influx;
    CancellationTokenSource? _cts;
    Task? _bridgeTask;

    public ScadaCore Core { get; }
    public ScadaConfig Config => _cfg;
    public CloudState Cloud => _bridge.State;
    public int LocalClients => _broker?.ClientCount ?? 0;
    public int WebPort => _web?.Port ?? 0;
    public int ModbusServerPort => _mbServer?.Port ?? 0;
    public string OpcUaServerEndpoint => _uaServer?.Endpoint ?? "";
    public bool RemoteControlAllowed => _cfg.AllowRemoteControl;
    public IScadaView View => Core;
    public event Action<string>? Log;

    public ScadaHost(ScadaConfig cfg, IRegisterDriver? driverOverride = null)
    {
        _cfg = cfg;
        Core = new ScadaCore(cfg, driverOverride ?? (cfg.PackBound ? null : DriverFactory.Create(cfg)));
        _bridge = new CloudBridge(cfg);
        Core.Log += l => Log?.Invoke(l);
        _bridge.Log += Core.Emit;
        _bridge.CommandReceived += OnCloudCommandAsync;
    }

    public async Task StartAsync()
    {
        _cts = new CancellationTokenSource();
        await GatewayActivation.EnsureAsync(_cfg, Core.Emit, _cts.Token);   // LicenseMode != none: chưa kích hoạt thì ném LicenseRequiredException
        var needBroker = _cfg.LocalBrokerEnabled || !Core.Direct;          // gateway ESP32 buộc phải có broker
        if (needBroker)
        {
            _broker = new LocalBroker(_cfg);
            _broker.Log += Core.Emit;
            _broker.MessageReceived += OnLanMessage;
            await _broker.StartAsync();
            Core.Emit($"Broker LAN (không mã hoá) nghe {_cfg.LocalBind}:{_cfg.LocalPort}, topic {_cfg.BaseTopic}/*");
            Core.ExternalCommandSink = p => _broker.PublishAsync(_cfg.BaseTopic + "/cmd", p, false, CoreSender);
        }
        Core.Publish += OnCorePublish;

        if (_cfg.WebActive)            // topology MultiScreen: máy chính phục vụ các màn hình phụ
        {
            _web = new LocalWebServer(_cfg, this);
            await _web.StartAsync();
            Core.Emit($"Màn hình phụ/web {(_cfg.AllowsControl(ControlSource.RemoteScreen) ? "giám sát + điều khiển" : "CHỈ GIÁM SÁT")}: {(string.IsNullOrWhiteSpace(_cfg.WebCertPath) ? "http" : "https")}://<ip-máy-này>:{_cfg.WebPort}");
        }
        if (_cfg.ModbusServerEnabled)
        {
            _mbServer = new ModbusTcpServer(_cfg.ServerBind, _cfg.ModbusServerPort, () => { var s = Core.State; return (DeviceState.ImageOf(s), s.Fresh && s.Status == "online"); });
            _mbServer.Log += Core.Emit;
            _mbServer.Start();
            Core.Emit($"Modbus TCP server (chỉ đọc) nghe {_cfg.ServerBind}:{_mbServer.Port}");
        }
        if (_cfg.OpcUaServerEnabled)
        {
            _uaServer = new OpcUaServerHost(_cfg, () => { var s = Core.State; return (s, DeviceState.ImageOf(s)); });
            await _uaServer.StartAsync();
            Core.Emit($"OPC UA server (chỉ đọc) {_uaServer.Endpoint}");
        }
        if (_cfg.InfluxEnabled)
        {
            _influx = new InfluxWriter(_cfg, () => Core.State);
            _influx.Log += Core.Emit;
            _influx.Start();
            Core.Emit($"Ghi InfluxDB {_cfg.InfluxUrl} bucket {_cfg.InfluxBucket} mỗi {_cfg.InfluxEverySec}s");
        }
        if (_cfg.CloudEnabled)
        {
            Core.Emit($"Cầu nối cloud: {_cfg.CloudTransport}://{_cfg.CloudHost}:{_cfg.CloudPort} (TLS), điện thoại: {(_cfg.Mobile == MobileAccess.Control ? "xem + điều khiển" : "CHỈ XEM")}");
            _bridgeTask = Task.Run(() => _bridge.RunAsync(_cts.Token));
        }
        await Core.StartAsync();
    }

    public async Task StopAsync()
    {
        _cts?.Cancel();
        if (_bridgeTask != null) { try { await _bridgeTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch { /* ignore */ } }
        await Core.StopAsync();
        if (_web != null) { await _web.DisposeAsync(); _web = null; }
        if (_mbServer != null) { await _mbServer.DisposeAsync(); _mbServer = null; }
        if (_uaServer != null) { await _uaServer.DisposeAsync(); _uaServer = null; }
        if (_influx != null) { await _influx.DisposeAsync(); _influx = null; }
        if (_broker != null) { await _broker.StopAsync(); }
    }

    // ------------------------------------------------------------------ lõi → dịch vụ
    void OnCorePublish(string kind, byte[] payload, bool retain)
    {
        var topic = $"{_cfg.BaseTopic}/{kind}";
        if (_cfg.CloudEnabled) Core.Trace(_bridge.State == CloudState.Connected ? "GW→Cloud" : "GW→Cloud (chưa nối)", topic, Encoding.UTF8.GetString(payload));
        _bridge.Forward(topic, payload, retain);
        _broker?.PublishAsync(topic, payload, retain, CoreSender);   // HMI MQTT trong LAN thấy cùng dữ liệu
    }

    // ------------------------------------------------------------------ broker LAN → lõi
    void OnLanMessage(BrokerMessage m)
    {
        if (m.Sender.StartsWith(LocalBroker.InternalPrefix, StringComparison.Ordinal)) return;   // tin do chính lõi phát, tránh vòng lặp
        var kind = Contract.KindOf(m.Topic, _cfg.BaseTopic);
        if (kind == null) return;
        if (kind == "cmd")
        {
            // HMI vai trò operator trong LAN: đi thẳng vào lõi (cùng whitelist) rồi trả ack
            _ = Task.Run(async () =>
            {
                var ack = await Core.ExecuteAsync(m.Payload, ControlSource.Lan, "lan:" + m.Sender);
                if (ack != null) await _broker!.PublishAsync(_cfg.BaseTopic + "/ack", Encoding.UTF8.GetBytes(ack), false, CoreSender);
            });
            return;
        }
        if (!Core.Direct) Core.ApplyExternal(kind, m.Payload, m.Retain);      // gateway ESP32 đẩy dữ liệu vào lõi
    }

    // ------------------------------------------------------------------ cloud → lõi
    /// <summary>Lệnh từ cloud: whitelist + công tắc điều khiển từ xa + giới hạn tốc độ, rồi đi thẳng vào lõi.</summary>
    async Task OnCloudCommandAsync(byte[] payload)
    {
        var replay = CheckReplay(payload);
        if (replay != null) { await RejectAsync(IdOf(payload), replay); return; }
        var rx = System.Diagnostics.Stopwatch.GetTimestamp();
        Core.Trace("Cloud→GW", _cfg.BaseTopic + "/cmd", Encoding.UTF8.GetString(payload) + TransitNote(payload));
        _bridge.Expedite();                                  // trạng thái PLC sau lệnh phải lên webapp ngay, không chờ khoảng chống dồn
        if (IsKeyCommand(payload))
        {
            // lệnh theo thiết bị con: cùng công tắc điều khiển từ xa + giới hạn tốc độ như lệnh thanh ghi
            if (!_cfg.AllowRemoteControl) { await RejectAsync(null, "remote_disabled"); return; }
            if (!TakeToken()) { await RejectAsync(null, "rate_limited"); return; }
            var kack = await Core.ExecuteKeyAsync(payload, ControlSource.Mobile, "mobile");
            Core.Trace("GW→PLC", "latency", $"lệnh đã xử lý tại gateway sau {System.Diagnostics.Stopwatch.GetElapsedTime(rx).TotalMilliseconds:F0} ms");
            if (kack != null)
            {
                Core.Trace("GW→Cloud", _cfg.BaseTopic + "/ack", kack);
                await _bridge.PublishAckAsync(kack);
            }
            return;
        }
        var (cmd, err, id) = CommandPolicy.Parse(payload);
        if (cmd == null) { await RejectAsync(id, err!); return; }
        if (!cmd.IsRead && !_cfg.AllowRemoteControl) { await RejectAsync(id, "remote_disabled"); return; }
        if (!TakeToken()) { await RejectAsync(id, "rate_limited"); return; }
        var ack = await Core.ExecuteAsync(payload, ControlSource.Mobile, "mobile");
        Core.Trace("GW→PLC", "latency", $"lệnh đã xử lý tại gateway sau {System.Diagnostics.Stopwatch.GetElapsedTime(rx).TotalMilliseconds:F0} ms");
        if (ack != null)
        {
            Core.Trace("GW→Cloud", _cfg.BaseTopic + "/ack", ack);
            await _bridge.PublishAckAsync(ack);
        }
    }

    /// <summary>Lệnh có "ts" (ms epoch lúc server phát): ước lượng thời gian server → gateway (chính xác tới độ lệch đồng hồ hai máy).</summary>
    static string TransitNote(byte[] payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("ts", out var ts) && ts.TryGetInt64(out var t))
                return $"  [server→gateway ≈ {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - t} ms]";
        }
        catch { /* không phải JSON: bỏ qua */ }
        return "";
    }

    static string? IdOf(byte[] payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            return doc.RootElement.TryGetProperty("id", out var i) ? (i.ValueKind == System.Text.Json.JsonValueKind.String ? i.GetString() : i.ToString()) : null;
        }
        catch (System.Text.Json.JsonException) { return null; }
    }

    /// <summary>Chống phát lại: id đã thấy → "replayed_cmd"; "ts" quá cũ/quá mới so với CmdMaxAgeSec → "stale_cmd"; còn lại null.</summary>
    string? CheckReplay(byte[] payload)
    {
        long? ts = null; string? id = null;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            var r = doc.RootElement;
            if (r.ValueKind != System.Text.Json.JsonValueKind.Object) return null;      // để CommandPolicy báo lỗi định dạng
            if (r.TryGetProperty("ts", out var t) && t.TryGetInt64(out var tv)) ts = tv;
            if (r.TryGetProperty("id", out var i)) id = i.ValueKind == System.Text.Json.JsonValueKind.String ? i.GetString() : i.ToString();
        }
        catch (System.Text.Json.JsonException) { return null; }
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_cfg.CmdMaxAgeSec > 0 && ts.HasValue && Math.Abs(now - ts.Value) > _cfg.CmdMaxAgeSec * 1000L)
        {
            Core.Emit($"Từ chối lệnh cũ/lệch đồng hồ: ts lệch {(now - ts.Value) / 1000} s (giới hạn {_cfg.CmdMaxAgeSec} s)");
            return "stale_cmd";
        }
        if (string.IsNullOrEmpty(id)) return null;
        lock (_seenCmdIds)
        {
            if (_seenCmdIds.Count >= SeenCmdMax || _seenCmdIds.Count > 0)
                foreach (var k in _seenCmdIds.Where(kv => now - kv.Value > SeenCmdWindowMs).Select(kv => kv.Key).ToList()) _seenCmdIds.Remove(k);
            if (_seenCmdIds.ContainsKey(id)) { Core.Emit($"Từ chối lệnh phát lại (id {id})"); return "replayed_cmd"; }
            if (_seenCmdIds.Count >= SeenCmdMax) return "rate_limited";
            _seenCmdIds[id] = now;
        }
        return null;
    }

    static bool IsKeyCommand(byte[] payload)
    {
        if (payload.Length is 0 or > CommandPolicy.MaxPayload) return false;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object && doc.RootElement.TryGetProperty("key", out _);
        }
        catch (System.Text.Json.JsonException) { return false; }
    }

    Task RejectAsync(string? id, string err)
    {
        Core.Emit($"Từ chối lệnh từ cloud: {err}");
        Core.Trace("GW→Cloud", _cfg.BaseTopic + "/ack", CommandPolicy.AckJson(id, false, err));
        return _bridge.PublishAckAsync(CommandPolicy.AckJson(id, false, err));
    }

    bool TakeToken()
    {
        lock (_rate)
        {
            var sec = Environment.TickCount64 / 1000;
            if (sec != _rateSec) { _rateSec = sec; _rateCount = 0; }
            return ++_rateCount <= Math.Max(1, _cfg.RemoteCmdPerSec);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        await _bridge.DisposeAsync();
        if (_broker != null) await _broker.DisposeAsync();
        await Core.DisposeAsync();
        _cts?.Dispose();
    }
}
