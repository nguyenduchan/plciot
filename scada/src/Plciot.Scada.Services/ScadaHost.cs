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
    InfluxWriter? _influx;
    CancellationTokenSource? _cts;
    Task? _bridgeTask;

    public ScadaCore Core { get; }
    public ScadaConfig Config => _cfg;
    public CloudState Cloud => _bridge.State;
    /// <summary>Gửi bù một mẫu lịch sử đã lưu lúc offline (xem CloudBridge.SendBackfillAsync).</summary>
    public Task<bool> SendBackfillAsync(byte[] payload, CancellationToken ct) => _bridge.SendBackfillAsync(payload, ct);
    public int LocalClients => _broker?.ClientCount ?? 0;
    public int WebPort => _web?.Port ?? 0;
    public int ModbusServerPort => _mbServer?.Port ?? 0;
    public bool RemoteControlAllowed => _cfg.AllowRemoteControl;
    public IScadaView View => Core;
    public event Action<string>? Log;

    public ScadaHost(ScadaConfig cfg, IRegisterDriver? driverOverride = null)
    {
        _cfg = cfg;
        // driverOverride (vd. PLC giả của Demo) thay cho kết nối theo cấu hình → không bắt địa chỉ PLC; driver tạo từ cấu hình thì kiểm tra đủ
        Core = new ScadaCore(cfg, driverOverride ?? (cfg.PackBound ? null : DriverFactory.Create(cfg)), driverSupplied: driverOverride != null);
        _bridge = new CloudBridge(cfg);
        Core.Log += l => Log?.Invoke(l);
        _bridge.Log += Core.Emit;
        _bridge.CommandReceived += OnCloudCommandAsync;
        _bridge.RpcReceived += OnRpcAsync;
        // chương trình logic: "mất mạng" = cloud đã bật mà không nối được; gateway không dùng cloud thì không bao giờ mất mạng
        Core.Logic.LinkUp = () => _cfg.CloudEnabled ? _bridge.State == CloudState.Connected : null;
    }

    /// <summary>Chương trình logic vừa đổi (app chủ đã nạp + lưu): gửi lại bản tin config (server lưu, webapp xem) + cảnh báo chủ trạm.</summary>
    public void LogicChanged(string text)
    {
        PublishConfig();
        OnCorePublish("alert", Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(new { k = "sec.logic_changed", lv = "high", txt = text })), false);
    }

    /// <summary>
    /// Cài đặt từ xa (GatewayAdmin → server → gw/&lt;mqttId&gt;/rpc): app chủ gắn ĐÚNG bộ xử lý API LAN của nó (method, path, body) → (status, json).
    /// null = gateway này không nhận cài đặt từ xa. Server đã kiểm quyền (máy admin đã đăng ký + chủ gateway cho phép) và chỉ cho route an toàn.
    /// </summary>
    public Func<string, string, string, Task<(int Status, string Json)>>? RpcHandler { get; set; }
    /// <summary>Mã duyệt của chủ trạm ("appr", trong phần server ký) của yêu cầu rpc ĐANG xử lý — "" = không có. Đổi chương trình logic từ xa bắt buộc có.</summary>
    public string RpcApproval => _rpcAppr.Value ?? "";
    readonly AsyncLocal<string?> _rpcAppr = new();

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
        PublishConfig();
    }

    /// <summary>Hiển thị do giao diện gateway đặt (tên thiết bị, nhãn/đơn vị/kiểu field) để đưa vào bản tin config. null = suy từ tên.</summary>
    public IConfigDescriber? Describer { get; set; }

    AlertEngine? _alertsEngine;
    AlertEngine _alerts => _alertsEngine ??= new AlertEngine(() => _cfg.Pack.Select(p =>
    {
        var v = Describer?.Field(p.Child, p.Field);
        return (p.Child + "." + p.WireKey, Describer?.DeviceTitle(p.Child) is { Length: > 0 } t ? t : p.Child,
            string.IsNullOrWhiteSpace(v?.Label) ? p.Field : v!.Label, v?.Unit ?? "", v?.Low, v?.High);
    }));

    /// <summary>Gateway khai báo danh sách thiết bị + field (đọc/ghi) lên &lt;base&gt;/config, retain. Gọi lúc khởi động (và mỗi lần áp cấu hình vì host được khởi động lại).</summary>
    public void PublishConfig()
    {
        try { OnCorePublish("config", ConfigBuilder.Build(_cfg, Describer, Core.Direct ? Core.Logic.CloudSummary(Describer) : null), true); }
        catch (Exception ex) { Core.Emit("Không tạo được bản tin config: " + ex.Message); }
    }

    public async Task StopAsync()
    {
        _cts?.Cancel();
        if (_bridgeTask != null) { try { await _bridgeTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch { /* ignore */ } }
        await Core.StopAsync();
        if (_web != null) { await _web.DisposeAsync(); _web = null; }
        if (_mbServer != null) { await _mbServer.DisposeAsync(); _mbServer = null; }
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
        if (kind == "telemetry")
            foreach (var a in _alerts.Evaluate(payload)) OnCorePublish("alert", a, false);   // cảnh báo tính tại gateway, server chỉ chuyển tiếp
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

    // ------------------------------------------------------------------ cài đặt từ xa (rpc)
    const int RpcChunk = 3000;          // mỗi phần base64 ≤ 3000 ký tự: gói rpcr < 4 KB (đường ingest của server chặn gói lớn hơn)
    const long RpcWindowMs = 60_000;
    readonly Dictionary<string, long> _seenRpc = new();

    async Task OnRpcAsync(byte[] payload)
    {
        if (_cfg.CloudCmdKey.Length == 0 || !CmdSignature.TryVerify(payload, _cfg.MqttId, _cfg.CloudCmdKey, out var plain, "rpc1"))
        {
            Core.Emit("Bỏ yêu cầu cài đặt từ xa: thiếu/sai chữ ký của server");
            return;   // không trả lời: ai đó không phải server gửi vào thì cũng không nhận được gì
        }
        string rid, m, p, b, adm, appr; long ts;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(plain);
            var r = doc.RootElement;
            rid = r.GetProperty("rid").GetString() ?? ""; m = r.GetProperty("m").GetString() ?? ""; p = r.GetProperty("p").GetString() ?? "";
            b = r.TryGetProperty("b", out var bv) ? bv.GetString() ?? "" : ""; adm = r.TryGetProperty("adm", out var av) ? av.GetString() ?? "" : "";
            ts = r.GetProperty("ts").GetInt64();
            appr = r.TryGetProperty("appr", out var ap) ? ap.GetString() ?? "" : "";
        }
        catch (Exception e) when (e is System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException) { return; }
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (rid.Length is 0 or > 64 || Math.Abs(now - ts) > RpcWindowMs) { Core.Emit("Bỏ yêu cầu cài đặt từ xa: quá cũ hoặc lệch đồng hồ"); return; }
        lock (_seenRpc)
        {
            foreach (var k in _seenRpc.Where(kv => now - kv.Value > 2 * RpcWindowMs).Select(kv => kv.Key).ToList()) _seenRpc.Remove(k);
            if (!_seenRpc.TryAdd(rid, now)) return;   // phát lại
        }
        int st; string json;
        if (RpcHandler is not { } h) (st, json) = (503, "{\"Ok\":false,\"Err\":\"rpc_unavailable\"}");
        else
        {
            var body = b.Length == 0 ? "" : Gunzip(Convert.FromBase64String(b));
            if (m != "GET" || p == "/api/config") Core.Emit($"Cài đặt từ xa ({adm}): {m} {p}");
            _rpcAppr.Value = appr;
            try { (st, json) = await h(m, p, body); }
            catch (Exception ex) { (st, json) = (500, System.Text.Json.JsonSerializer.Serialize(new { Ok = false, Err = ex.Message })); }
        }
        var z = Convert.ToBase64String(Gzip(Encoding.UTF8.GetBytes(json)));
        var n = Math.Max(1, (z.Length + RpcChunk - 1) / RpcChunk);
        for (var i = 0; i < n; i++)
        {
            var part = z.Substring(i * RpcChunk, Math.Min(RpcChunk, z.Length - i * RpcChunk));
            var msg = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { rid, i, n, st, z = part });
            if (!await _bridge.PublishRpcReplyAsync(msg)) { Core.Emit("Không gửi được trả lời cài đặt từ xa (mất cloud)"); return; }
        }
    }

    static byte[] Gzip(byte[] data)
    {
        using var ms = new MemoryStream();
        using (var gz = new System.IO.Compression.GZipStream(ms, System.IO.Compression.CompressionLevel.Optimal)) gz.Write(data);
        return ms.ToArray();
    }
    static string Gunzip(byte[] data)
    {
        using var gz = new System.IO.Compression.GZipStream(new MemoryStream(data), System.IO.Compression.CompressionMode.Decompress);
        using var sr = new StreamReader(gz, Encoding.UTF8);
        return sr.ReadToEnd();
    }

    // ------------------------------------------------------------------ cloud → lõi
    /// <summary>Lệnh từ cloud: whitelist + công tắc điều khiển từ xa + giới hạn tốc độ, rồi đi thẳng vào lõi.</summary>
    async Task OnCloudCommandAsync(byte[] payload)
    {
        // Cloud ký mọi lệnh (cloud/app/src/cmdSign.js). Đã có khoá công khai của server → BẮT BUỘC chữ ký đúng (kể cả lệnh sys);
        // chữ ký đúng nghĩa là lệnh đã qua step-up Face ID/TOTP ở server → không cần OTP/mật khẩu cục bộ. Chưa có khoá (server cũ) → như trước.
        var trusted = false;
        if (_cfg.CloudCmdKey.Length > 0)
        {
            if (!CmdSignature.TryVerify(payload, _cfg.MqttId, _cfg.CloudCmdKey, out var plain))
            {
                Core.Emit("Từ chối lệnh cloud: thiếu/sai chữ ký của server");
                await RejectAsync(IdOf(payload), "bad_sig");
                return;
            }
            payload = plain; trusted = true;
        }
        var replay = CheckReplay(payload);
        if (replay != null) { await RejectAsync(IdOf(payload), replay); return; }
        var sys = SysOf(payload);
        if (sys != null)
        {
            // Tín hiệu hệ thống từ server (không phải lệnh điều khiển PLC): bật/tắt gửi data theo tem có user hay chưa
            if (sys == "claimed") { _cfg.CloudSendData = true; Core.Emit("Server báo tem đã có user — bắt đầu gửi data lên cloud"); }
            else if (sys == "live") _bridge.SetLive(TtlOf(payload));   // có người đang xem webapp → gửi nhanh trong ttl giây
            else if (sys == "unclaimed") { _cfg.CloudSendData = false; Core.Emit("Server báo tem không còn user — ngừng gửi data, chỉ đồng bộ setting"); }
            return;
        }
        var rx = System.Diagnostics.Stopwatch.GetTimestamp();
        Core.Trace("Cloud→GW", _cfg.BaseTopic + "/cmd", Encoding.UTF8.GetString(payload) + TransitNote(payload));
        _bridge.Expedite();                                  // trạng thái PLC sau lệnh phải lên webapp ngay, không chờ khoảng chống dồn
        if (IsKeyCommand(payload))
        {
            // lệnh theo thiết bị con: cùng công tắc điều khiển từ xa + giới hạn tốc độ như lệnh thanh ghi
            if (!_cfg.AllowRemoteControl) { await RejectAsync(null, "remote_disabled"); return; }
            if (!TakeToken()) { await RejectAsync(null, "rate_limited"); return; }
            var kack = await Core.ExecuteKeyAsync(payload, ControlSource.Mobile, "mobile", default, trusted);
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
        var ack = await Core.ExecuteAsync(payload, ControlSource.Mobile, "mobile", default, trusted);
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
    static int TtlOf(byte[] payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            return doc.RootElement.TryGetProperty("ttl", out var t) && t.TryGetInt32(out var v) ? v : 60;
        }
        catch (System.Text.Json.JsonException) { return 60; }
    }

    static string? SysOf(byte[] payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                && doc.RootElement.TryGetProperty("sys", out var s) && s.ValueKind == System.Text.Json.JsonValueKind.String ? s.GetString() : null;
        }
        catch (System.Text.Json.JsonException) { return null; }
    }

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
