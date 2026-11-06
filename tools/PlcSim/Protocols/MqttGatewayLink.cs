using System.Text;
using System.Text.Json;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Protocol;

namespace PlcSim.Protocols;

/// <summary>
/// PLC chủ động đẩy dữ liệu vào broker LAN của gateway C# (vai trò "Device", tài khoản gw):
///   plc/&lt;site&gt;/&lt;device&gt;/telemetry  {"schema":2,"r":[..],"d":{child:{field:v}}}  (retain)
///   plc/&lt;site&gt;/&lt;device&gt;/status     online | offline (LWT, retain)
///   plc/&lt;site&gt;/&lt;device&gt;/cmd        lệnh từ webapp/gateway → áp dụng vào model → trả ack
///   plc/&lt;site&gt;/&lt;device&gt;/ack        {"id","ok",...}
/// Gateway chuyển tiếp telemetry/status/ack lên cloud, webapp thấy ngay.
/// </summary>
public sealed class MqttGatewayLink : IEndpoint
{
    readonly PlcModel _m;
    readonly string _host, _user, _pass, _base;
    readonly int _port;
    readonly Action<string> _log;
    readonly IMqttClient _c;
    readonly SemaphoreSlim _conn = new(1, 1);

    public string Name => "MQTT → Gateway";
    public int Peers => _c.IsConnected ? 1 : 0;

    public MqttGatewayLink(PlcModel m, string host, int port, string user, string pass, string site, string device, Action<string> log)
    {
        _m = m; _host = host; _port = port; _user = user; _pass = pass; _log = log;
        _base = $"plc/{site}/{device}";
        _c = new MqttFactory().CreateMqttClient();
        _c.ApplicationMessageReceivedAsync += OnMessage;
        _c.DisconnectedAsync += e => { _log($"MQTT: mất kết nối gateway{(e.Exception != null ? " (" + e.Exception.Message + ")" : "")}"); return Task.CompletedTask; };
    }

    public async Task StartAsync()
    {
        await EnsureConnectedAsync();
    }

    async Task<bool> EnsureConnectedAsync()
    {
        if (_c.IsConnected) return true;
        await _conn.WaitAsync();
        try
        {
            if (_c.IsConnected) return true;
            var o = new MqttClientOptionsBuilder()
                .WithTcpServer(_host, _port)
                .WithClientId($"plcsim-{Environment.MachineName}-{Environment.ProcessId}".ToLowerInvariant())
                .WithCredentials(_user, _pass)
                .WithCleanSession()
                .WithKeepAlivePeriod(TimeSpan.FromSeconds(20))
                .WithTimeout(TimeSpan.FromSeconds(5))
                .WithWillTopic(_base + "/status").WithWillPayload("offline").WithWillRetain()
                .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .Build();
            try
            {
                var res = await _c.ConnectAsync(o);
                if (res.ResultCode != MqttClientConnectResultCode.Success)
                {
                    _log($"MQTT: gateway từ chối ({res.ResultCode}) — kiểm tra user/password trong LocalUsers của gateway");
                    return false;
                }
                await _c.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
                    .WithTopicFilter(_base + "/cmd", MqttQualityOfServiceLevel.AtMostOnce).Build());
                await PublishAsync(_base + "/status", "online", true);
                _log($"MQTT: đã nối gateway {_host}:{_port}, topic {_base}/*");
                return true;
            }
            catch (Exception ex)
            {
                _log($"MQTT: không nối được {_host}:{_port} — {ex.Message}");
                return false;
            }
        }
        finally { _conn.Release(); }
    }

    public async Task PushAsync()
    {
        if (!await EnsureConnectedAsync()) return;
        var json = _m.TelemetryJson();
        await PublishAsync(_base + "/telemetry", json, true);
        _log($"→ gateway telemetry {json.Length}B");
    }

    Task PublishAsync(string topic, string payload, bool retain) =>
        _c.IsConnected
            ? _c.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(topic).WithPayload(Encoding.UTF8.GetBytes(payload))
                .WithRetainFlag(retain).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtMostOnce).Build())
            : Task.CompletedTask;

    async Task OnMessage(MqttApplicationMessageReceivedEventArgs e)
    {
        if (e.ApplicationMessage.Topic != _base + "/cmd") return;
        var text = Encoding.UTF8.GetString(e.ApplicationMessage.PayloadSegment);
        _log($"← cmd {text}");
        var ack = Execute(text);
        await PublishAsync(_base + "/ack", ack, false);
        _log($"→ ack {ack}");
        await PushAsync();                       // gửi ngay trạng thái mới để webapp thấy kết quả điều khiển
    }

    /// <summary>
    /// Lệnh theo hợp đồng: {"id","a","v"} ghi D[a]; {"id","op":"read","a","n"} đọc; {"id","key","v"[,"child"]} ghi field thiết bị con.
    /// </summary>
    public string Execute(string json)
    {
        string? id = null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return Ack(null, false, "bad_cmd");
            if (r.TryGetProperty("id", out var idEl)) id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.ToString();

            if (r.TryGetProperty("key", out var keyEl) && keyEl.ValueKind == JsonValueKind.String)
            {
                if (!r.TryGetProperty("v", out var kv) || !kv.TryGetDouble(out var d)) return Ack(id, false, "bad_value");
                var child = r.TryGetProperty("child", out var ch) && ch.ValueKind == JsonValueKind.String ? ch.GetString() : null;
                _log($"Điều khiển {keyEl.GetString()} = {d}{(child != null ? " (" + child + ")" : "")}");
                var n = _m.ApplyKeyCommand(child, keyEl.GetString()!, d, "gateway");
                return n > 0 ? Ack(id, true) : Ack(id, false, "unknown_key");
            }
            if (!r.TryGetProperty("a", out var aEl) || !aEl.TryGetInt32(out var a) || !_m.InRange(a, 1)) return Ack(id, false, "bad_address");
            if (r.TryGetProperty("op", out var op) && op.GetString() == "read")
            {
                var n = r.TryGetProperty("n", out var nEl) && nEl.TryGetInt32(out var nn) ? nn : 1;
                if (n < 1 || n > 60 || !_m.InRange(a, n)) return Ack(id, false, "bad_range");
                return JsonSerializer.Serialize(new Dictionary<string, object?> { ["id"] = id, ["ok"] = true, ["a"] = a, ["v"] = _m.Read(a, n) });
            }
            if (!r.TryGetProperty("v", out var vEl) || !vEl.TryGetInt32(out var v) || v is < 0 or > 65535) return Ack(id, false, "bad_value");
            _log($"Điều khiển D{a} = {v}");
            _m.Set(a, (ushort)v, "gateway");
            return Ack(id, true);
        }
        catch (JsonException) { return Ack(id, false, "bad_json"); }
    }

    static string Ack(string? id, bool ok, string? err = null) =>
        JsonSerializer.Serialize(err == null
            ? new Dictionary<string, object?> { ["id"] = id, ["ok"] = ok }
            : new Dictionary<string, object?> { ["id"] = id, ["ok"] = ok, ["err"] = err });

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_c.IsConnected)
            {
                await PublishAsync(_base + "/status", "offline", true);
                await _c.DisconnectAsync();
            }
        }
        catch { /* ignore */ }
        _c.Dispose();
    }
}
