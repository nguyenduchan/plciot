using System.Text;
using System.Text.Json;

namespace Plciot.Scada;

/// <summary>
/// LÕI SCADA (không giao diện, không mạng ngoài): giữ kết nối tới PLC qua một <see cref="IRegisterDriver"/>, đọc theo chu kỳ vào
/// <see cref="DeviceState"/> và THỰC THI LỆNH THẲNG xuống driver — giao diện gọi <see cref="WriteAsync"/> là tới PLC ngay,
/// không đi qua broker, HTTP hay hàng đợi nào. Các dịch vụ tuỳ chọn (cloud, web, server Modbus/OPC UA, InfluxDB...) chỉ
/// <b>đăng ký nghe</b> <see cref="Publish"/> và gọi <see cref="ExecuteAsync"/>; chúng nằm ở dự án Services.
///
/// Chế độ gateway (driver = null): dữ liệu do gateway ESP32 đẩy vào qua <see cref="ApplyExternal"/> và lệnh phải gửi qua
/// <see cref="ExternalCommandSink"/> (đường đi duy nhất có thể, vì PLC chỉ nói chuyện với gateway).
/// </summary>
public sealed class ScadaCore : IScadaView, IAsyncDisposable
{
    readonly ScadaConfig _cfg;
    readonly IRegisterDriver? _driver;
    readonly DeviceState _state = new();
    readonly SemaphoreSlim _pollNow = new(0, 1);
    readonly IReadOnlySet<int> _writable;
    readonly Queue<string> _log = new();
    CancellationTokenSource? _cts;
    Task? _loop;
    string _status = "";
    DateTime _statusAt;
    int _fails;

    public ScadaCore(ScadaConfig cfg, IRegisterDriver? driver)
    {
        var err = cfg.Validate();
        if (err != null) throw new ArgumentException(err);
        _cfg = cfg;
        _driver = driver;
        // địa chỉ khai báo trong Pack là các điểm điều khiển thiết bị con (cloud đã whitelist theo widget) nên được phép ghi
        _writable = cfg.WritableRegisters.Concat(cfg.Pack.Select(x => x.Address)).ToHashSet();
    }

    public ScadaConfig Config => _cfg;
    public string Site => _cfg.Site;
    public string Device => _cfg.Device;
    public string BaseTopic => _cfg.BaseTopic;
    public bool Direct => _driver != null;
    public bool CanControl => true;
    public DeviceState.Snapshot State => _state.Get();
    public string InfoLine => Direct ? $"Nguồn: {_cfg.Source} {_cfg.PlcHost}" : "Nguồn: gateway";
    public string[] RecentLog { get { lock (_log) return _log.ToArray(); } }

    public event Action<string>? Log;
    /// <summary>Luồng dữ liệu để hiển thị/giám sát: (hướng, kênh, nội dung). Hướng: "PLC→GW", "GW→PLC", "GW→Cloud", "Cloud→GW".</summary>
    public event Action<string, string, string>? Traffic;
    public void Trace(string direction, string channel, string text) => Traffic?.Invoke(direction, channel, text);
    /// <summary>Dữ liệu mới theo hợp đồng MQTT (kind = telemetry|status|history, payload JSON/chuỗi, retain) cho các dịch vụ tuỳ chọn.</summary>
    public event Action<string, byte[], bool>? Publish;
    /// <summary>Chế độ gateway: nơi gửi lệnh tới gateway.</summary>
    public Func<byte[], Task>? ExternalCommandSink { get; set; }

    public void Emit(string s)
    {
        var line = $"{DateTime.Now:HH:mm:ss} {s}";
        lock (_log) { _log.Enqueue(line); while (_log.Count > 200) _log.Dequeue(); }
        Log?.Invoke(line);
    }

    public Task StartAsync()
    {
        _cts = new CancellationTokenSource();
        if (_driver != null) _loop = Task.Run(() => PollLoopAsync(_cts.Token));
        return Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        _cts?.Cancel();
        if (_loop != null) { try { await _loop.WaitAsync(TimeSpan.FromSeconds(5)); } catch { /* ignore */ } }
    }

    // ------------------------------------------------------------------ đọc
    async Task PollLoopAsync(CancellationToken ct)
    {
        var lastHistory = DateTime.MinValue;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var packMax = _cfg.Pack.Count == 0 ? 0 : _cfg.Pack.Max(x => x.Address) + 1;
                var all = await _driver!.ReadAsync(0, Math.Max(Contract.TelemetryRegs, packMax), ct);
                var regs = all[..Contract.TelemetryRegs];
                _fails = 0;
                SetStatus("online");
                _state.SetTelemetry(regs);
                Trace("PLC→GW", _cfg.Source.ToString(), $"read D0..D{all.Length - 1}: {string.Join(',', all.Take(Contract.TelemetryRegs))}");
                if (Publish != null) Publish("telemetry", BuildTelemetry(regs, all), true);
                if ((DateTime.UtcNow - lastHistory).TotalMilliseconds >= _cfg.HistoryMs)
                {
                    await ReadHistoryAsync(ct);
                    lastHistory = DateTime.UtcNow;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                if (++_fails == 3) Emit($"Mất liên lạc PLC ({_cfg.Source}) {_cfg.PlcHost}: {ex.Message}");
                if (_fails >= 3) SetStatus("plc_fault");
            }
            try
            {
                // chờ hết chu kỳ, hoặc dậy ngay khi vừa ghi lệnh để giao diện thấy kết quả sớm nhất
                await Task.WhenAny(Task.Delay(_cfg.PollMs, ct), _pollNow.WaitAsync(ct));
            }
            catch (OperationCanceledException) { break; }
        }
        SetStatus("offline", force: true);
    }

    /// <summary>Không có Pack: {"r":[..]} như cũ. Có Pack: {"schema":2,"r":[..],"d":{child:{field:số}}}.</summary>
    byte[] BuildTelemetry(ushort[] regs, ushort[] all)
    {
        if (_cfg.Pack.Count == 0) return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { r = regs }));
        var d = new Dictionary<string, Dictionary<string, double>>();
        foreach (var x in _cfg.Pack)
        {
            if (!d.TryGetValue(x.Child, out var f)) d[x.Child] = f = new();
            f[x.Field] = Math.Round(all[x.Address] / x.Scale, 3);
        }
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { schema = 2, r = regs, d }));
    }

    async Task ReadHistoryAsync(CancellationToken ct)
    {
        var a = await _driver!.ReadAsync(100, 51, ct);     // D100..D150
        var b = await _driver.ReadAsync(199, 50, ct);      // D199..D248
        _state.SetHistory(new DeviceState.HistoryBlock(
            a[..49].Select(v => (int)v).ToArray(), a[49], a[50], b[0], b[1..50].Select(v => (int)v).ToArray()));
        if (Publish != null)
        {
            var hist = new { c = a[..49], s = a[49], n = a[50], r = b[0], m = b[1..50] };
            Publish("history", Encoding.UTF8.GetBytes(JsonSerializer.Serialize(hist)), true);
        }
    }

    void SetStatus(string status, bool force = false)
    {
        if (!force && status == _status && (DateTime.UtcNow - _statusAt).TotalSeconds < 60) return;
        _status = status;
        _statusAt = DateTime.UtcNow;
        _state.SetStatus(status);
        Publish?.Invoke("status", Encoding.ASCII.GetBytes(status), true);
    }

    // ------------------------------------------------------------------ chế độ gateway
    /// <summary>Gateway ESP32 đẩy dữ liệu vào (telemetry/status/history/ack JSON theo hợp đồng).</summary>
    public void ApplyExternal(string kind, byte[] payload, bool retain = true)
    {
        _state.Apply(kind, payload);
        Trace("PLC→GW", "MQTT " + kind, Encoding.UTF8.GetString(payload));
        Publish?.Invoke(kind, payload, retain);
    }

    // ------------------------------------------------------------------ điều khiển
    /// <summary>Kết quả thực thi lệnh: JSON ack theo hợp đồng ({"id","ok",...}) hoặc null nếu ack sẽ do gateway gửi sau.</summary>
    public async Task<string?> ExecuteAsync(byte[] payload, ControlSource source, string actor, CancellationToken ct = default)
    {
        var (cmd, err, id) = CommandPolicy.Parse(payload, _writable);
        if (cmd == null) return CommandPolicy.AckJson(id, false, err);
        // MỘT điểm kiểm soát quyền điều khiển cho mọi nguồn (màn hình chính, màn hình phụ, điện thoại, LAN): đọc luôn được, ghi theo chính sách
        if (!cmd.IsRead && !_cfg.AllowsControl(source))
        {
            Emit($"Từ chối lệnh ghi từ {source} ({actor}): chính sách không cho phép");
            return CommandPolicy.AckJson(cmd.Id, false, source == ControlSource.Mobile ? "remote_disabled" : "control_disabled");
        }
        return await ExecuteAsync(cmd, actor, payload, ct);
    }

    async Task<string?> ExecuteAsync(PlcCommand cmd, string actor, byte[]? raw, CancellationToken ct)
    {
        if (_driver == null)
        {
            if (ExternalCommandSink == null) return CommandPolicy.AckJson(cmd.Id, false, "no_link");
            if (!cmd.IsRead) Emit($"Điều khiển ({actor}) qua gateway: D{cmd.Address} = {cmd.Value}");
            Trace("GW→PLC", "MQTT", Encoding.UTF8.GetString(raw ?? Array.Empty<byte>()));
            raw ??= Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { id = cmd.Id, a = cmd.Address, v = cmd.Value }));
            await ExternalCommandSink(raw);
            return null;
        }
        string ack;
        try
        {
            if (cmd.IsRead)
            {
                var vals = await _driver.ReadAsync(cmd.Address, cmd.Count, ct);
                ack = CommandPolicy.AckJson(cmd.Id, true, null, cmd.Address, vals);
            }
            else
            {
                Trace("GW→PLC", _cfg.Source.ToString(), $"write D{cmd.Address} = {cmd.Value}");
                await _driver.WriteAsync(cmd.Address, (ushort)cmd.Value, ct);        // THẲNG xuống PLC
                Emit($"Điều khiển ({actor}): D{cmd.Address} = {cmd.Value}");
                ack = CommandPolicy.AckJson(cmd.Id, true);
                if (_pollNow.CurrentCount == 0) { try { _pollNow.Release(); } catch (SemaphoreFullException) { } }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Emit($"Lệnh PLC lỗi ({actor}): {ex.Message}");
            ack = CommandPolicy.AckJson(cmd.Id, false, "plc_error");
        }
        _state.SetAck(ack);
        return ack;
    }

    /// <summary>
    /// Lệnh theo thiết bị con từ cloud: {"id","child","key","v"}. Có driver → đổi thành ghi thanh ghi theo <see cref="ScadaConfig.Pack"/>
    /// (D = v × Scale) rồi chạy qua đường thường (whitelist, chính sách). Chế độ gateway → chuyển nguyên lệnh cho PLC/gateway, ack đến sau.
    /// Trả về JSON ack, hoặc null nếu ack sẽ do PLC gửi.
    /// </summary>
    public async Task<string?> ExecuteKeyAsync(byte[] payload, ControlSource source, string actor, CancellationToken ct = default)
    {
        string? id = null, child = null, key;
        double v;
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var r = doc.RootElement;
            if (r.TryGetProperty("id", out var idEl)) id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.ToString();
            key = r.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null;
            if (key == null || !r.TryGetProperty("v", out var vEl) || !vEl.TryGetDouble(out v)) return CommandPolicy.AckJson(id, false, "bad_value");
            if (r.TryGetProperty("child", out var c) && c.ValueKind == JsonValueKind.String) child = c.GetString();
        }
        catch (JsonException) { return CommandPolicy.AckJson(null, false, "bad_json"); }
        if (!_cfg.AllowsControl(source))
        {
            Emit($"Từ chối lệnh ghi từ {source} ({actor}): chính sách không cho phép");
            return CommandPolicy.AckJson(id, false, source == ControlSource.Mobile ? "remote_disabled" : "control_disabled");
        }
        // giới hạn do tem provisioning đặt cho trường này: gateway tự kiểm lại, không tin hoàn toàn vào cloud
        var field = _cfg.Pack.FirstOrDefault(x => string.Equals(x.Field, key, StringComparison.OrdinalIgnoreCase)
            && (child == null || string.Equals(x.Child, child, StringComparison.OrdinalIgnoreCase)));
        if (field != null && ((field.Min.HasValue && v < field.Min) || (field.Max.HasValue && v > field.Max)))
        {
            Emit($"Từ chối lệnh {child}.{key} = {v}: ngoài khoảng {field.Min}–{field.Max}");
            return CommandPolicy.AckJson(id, false, "value_out_of_range");
        }
        if (_driver == null)
        {
            if (ExternalCommandSink == null) return CommandPolicy.AckJson(id, false, "no_link");
            Emit($"Điều khiển ({actor}) qua gateway: {child}.{key} = {v}");
            Trace("GW→PLC", "MQTT", Encoding.UTF8.GetString(payload));
            await ExternalCommandSink(payload);
            return null;
        }
        var map = _cfg.Pack.FirstOrDefault(x => string.Equals(x.Field, key, StringComparison.OrdinalIgnoreCase)
            && (child == null || string.Equals(x.Child, child, StringComparison.OrdinalIgnoreCase)));
        if (map == null) return CommandPolicy.AckJson(id, false, "unknown_key");
        var raw = Math.Round(v * map.Scale);
        if (raw is < 0 or > 65535) return CommandPolicy.AckJson(id, false, "bad_value");
        var translated = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { id, a = map.Address, v = (int)raw }));
        return await ExecuteAsync(translated, source, actor, ct);
    }

    /// <summary>Ghi từ màn hình trên máy chính (<see cref="ControlSource.LocalScreen"/>).</summary>
    public Task<string?> WriteAsync(int address, int value, string actor = "ui", CancellationToken ct = default) =>
        WriteAsync(address, value, ControlSource.LocalScreen, actor, ct);

    public async Task<string?> WriteAsync(int address, int value, ControlSource source, string actor, CancellationToken ct = default)
    {
        var id = Guid.NewGuid().ToString("N")[..8];
        var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { id, a = address, v = value }));
        var ack = await ExecuteAsync(payload, source, actor, ct);
        if (ack == null) return null;                               // gateway: ack đến sau
        using var doc = JsonDocument.Parse(ack);
        return doc.RootElement.GetProperty("ok").GetBoolean() ? null : doc.RootElement.TryGetProperty("err", out var e) ? e.GetString() : "failed";
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _driver?.Dispose();
        _cts?.Dispose();
    }
}
