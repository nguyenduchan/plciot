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
        Core = new ScadaCore(cfg, driverOverride ?? DriverFactory.Create(cfg));
        _bridge = new CloudBridge(cfg);
        Core.Log += l => Log?.Invoke(l);
        _bridge.Log += Core.Emit;
        _bridge.CommandReceived += OnCloudCommandAsync;
    }

    public async Task StartAsync()
    {
        _cts = new CancellationTokenSource();
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
        var (cmd, err, id) = CommandPolicy.Parse(payload);
        if (cmd == null) { await RejectAsync(id, err!); return; }
        if (!cmd.IsRead && !_cfg.AllowRemoteControl) { await RejectAsync(id, "remote_disabled"); return; }
        if (!TakeToken()) { await RejectAsync(id, "rate_limited"); return; }
        var ack = await Core.ExecuteAsync(payload, ControlSource.Mobile, "mobile");
        if (ack != null) await _bridge.PublishAckAsync(ack);
    }

    Task RejectAsync(string? id, string err)
    {
        Core.Emit($"Từ chối lệnh từ cloud: {err}");
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
