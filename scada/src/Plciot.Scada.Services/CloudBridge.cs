using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Protocol;

namespace Plciot.Scada;

public enum CloudState { Disabled, Disconnected, Connecting, Connected }

/// <summary>
/// Đóng gói MQTT cục bộ (không mã hoá) thành MQTT qua TLS gửi lên máy chủ cloud:
/// telemetry/status/ack/history đi lên; chỉ topic cmd đi xuống (và phải qua kiểm tra ở <see cref="ScadaEngine"/>).
/// Không bao giờ publish cmd lên cloud nên không thể tạo vòng lặp.
/// </summary>
public sealed class CloudBridge : IAsyncDisposable
{
    const int MaxPayload = 4096;     // khớp max_packet_size của broker cloud

    readonly ScadaConfig _cfg;
    readonly IMqttClient _client;
    readonly ConcurrentDictionary<string, (byte[] Payload, bool Retain)> _latest = new();
    readonly ConcurrentDictionary<string, long> _lastTele = new();
    readonly ConcurrentDictionary<string, (byte[] Payload, bool Retain)> _pendingTele = new();
    readonly string _cmdTopic;
    TaskCompletionSource _dropped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    volatile CloudState _state;

    public CloudState State
    {
        get => _state;
        private set { if (_state == value) return; _state = value; StateChanged?.Invoke(value); }
    }
    public event Action<CloudState>? StateChanged;
    public event Action<string>? Log;
    /// <summary>Lệnh nhận từ cloud (payload thô, CHƯA kiểm tra).</summary>
    public event Func<byte[], Task>? CommandReceived;

    public CloudBridge(ScadaConfig cfg)
    {
        _cfg = cfg;
        _cmdTopic = cfg.BaseTopic + "/cmd";
        _client = new MqttFactory().CreateMqttClient();
        _client.ApplicationMessageReceivedAsync += OnMessage;
        _client.DisconnectedAsync += e => { _dropped.TrySetResult(); return Task.CompletedTask; };
        _state = cfg.CloudEnabled ? CloudState.Disconnected : CloudState.Disabled;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        if (!_cfg.CloudEnabled) return;
        var delay = TimeSpan.FromSeconds(2);
        var flusher = FlushLoopAsync(ct);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                State = CloudState.Connecting;
                _dropped = new(TaskCreationOptions.RunContinuationsAsynchronously);
                var res = await _client.ConnectAsync(BuildOptions(), ct);
                if (res.ResultCode != MqttClientConnectResultCode.Success)
                    throw new InvalidOperationException($"cloud từ chối: {res.ResultCode}");
                await _client.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
                    .WithTopicFilter(_cmdTopic, MqttQualityOfServiceLevel.AtMostOnce).Build(), ct);
                State = CloudState.Connected;
                Log?.Invoke($"Đã nối cloud {_cfg.CloudHost}:{_cfg.CloudPort} ({_cfg.CloudTransport}, TLS)");
                delay = TimeSpan.FromSeconds(2);
                foreach (var (topic, v) in _latest.ToArray())          // đồng bộ lại trạng thái hiện tại lên cloud
                    await SendAsync(topic, v.Payload, v.Retain, ct);
                await Task.WhenAny(_dropped.Task, Task.Delay(Timeout.Infinite, ct));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                Log?.Invoke($"Cloud: {ex.Message}");
            }
            State = CloudState.Disconnected;
            try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { break; }
            delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 30));
        }
        // tắt chủ động thì LWT không chạy: tự báo offline để webapp không thấy trạng thái cũ
        try { await SendAsync(_cfg.BaseTopic + "/status", Encoding.ASCII.GetBytes("offline"), true, CancellationToken.None); } catch { /* ignore */ }
        try { if (_client.IsConnected) await _client.DisconnectAsync(); } catch { /* ignore */ }
        State = _cfg.CloudEnabled ? CloudState.Disconnected : CloudState.Disabled;
        await flusher.ContinueWith(_ => { });
    }

    MqttClientOptions BuildOptions()
    {
        var tls = new MqttClientTlsOptionsBuilder()
            .UseTls()
            .WithTargetHost(_cfg.CloudHost)
            .WithSslProtocols(SslProtocols.Tls12 | SslProtocols.Tls13)
            .WithCertificateValidationHandler(ValidateServerCert)
            .Build();
        var b = new MqttClientOptionsBuilder()
            .WithClientId($"scada-{_cfg.Site}-{_cfg.Device}-{_cfg.ClientSuffix}")
            .WithCredentials(_cfg.CloudUser, _cfg.CloudPassword)
            .WithCleanSession()
            .WithKeepAlivePeriod(TimeSpan.FromSeconds(30))
            .WithTimeout(TimeSpan.FromSeconds(10))
            .WithWillTopic(_cfg.BaseTopic + "/status")
            .WithWillPayload(Encoding.ASCII.GetBytes("offline"))
            .WithWillRetain()
            .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
            .WithTlsOptions(tls);
        if (_cfg.CloudTransport == "wss")
            b.WithWebSocketServer(o => o.WithUri($"wss://{_cfg.CloudHost}:{_cfg.CloudPort}{_cfg.CloudWsPath}"));
        else
            b.WithTcpServer(_cfg.CloudHost, _cfg.CloudPort);
        return b.Build();
    }

    bool ValidateServerCert(MqttClientCertificateValidationEventArgs ctx)
    {
        var pin = _cfg.CloudPinSha256.Replace(":", "").Replace(" ", "");
        if (pin.Length > 0)
        {
            // ghim chứng chỉ: chấp nhận đúng chứng chỉ này (kể cả tự ký), từ chối mọi chứng chỉ khác
            using var cert = new X509Certificate2(ctx.Certificate);
            return string.Equals(Convert.ToHexString(cert.GetCertHash(System.Security.Cryptography.HashAlgorithmName.SHA256)),
                pin, StringComparison.OrdinalIgnoreCase);
        }
        return ctx.SslPolicyErrors == System.Net.Security.SslPolicyErrors.None;
    }

    async Task OnMessage(MqttApplicationMessageReceivedEventArgs e)
    {
        if (e.ApplicationMessage.Topic != _cmdTopic) return;
        var h = CommandReceived;
        if (h != null) await h(e.ApplicationMessage.PayloadSegment.ToArray());
    }

    /// <summary>Gửi lên cloud (hoặc ghi nhớ để đồng bộ khi nối lại). Telemetry bị gộp theo CloudTelemetryMinMs.</summary>
    public void Forward(string topic, byte[] payload, bool retain)
    {
        if (!_cfg.CloudEnabled || payload.Length > MaxPayload) return;
        if (retain) _latest[topic] = (payload, retain);
        if (State != CloudState.Connected) return;
        if (topic.EndsWith("/telemetry", StringComparison.Ordinal))
        {
            var now = Stopwatch.GetTimestamp();
            var last = _lastTele.GetOrAdd(topic, 0);
            if (last != 0 && Stopwatch.GetElapsedTime(last, now).TotalMilliseconds < _cfg.CloudTelemetryMinMs)
            {
                _pendingTele[topic] = (payload, retain);
                return;
            }
            _lastTele[topic] = now;
            _pendingTele.TryRemove(topic, out _);
        }
        _ = SendAsync(topic, payload, retain, CancellationToken.None);
    }

    /// <summary>Gửi trực tiếp một phản hồi (ví dụ từ chối lệnh) lên cloud.</summary>
    public Task PublishAckAsync(string json) =>
        State == CloudState.Connected
            ? SendAsync(_cfg.BaseTopic + "/ack", Encoding.UTF8.GetBytes(json), false, CancellationToken.None)
            : Task.CompletedTask;

    async Task SendAsync(string topic, byte[] payload, bool retain, CancellationToken ct)
    {
        try
        {
            if (!_client.IsConnected) return;
            await _client.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(topic).WithPayload(payload)
                .WithRetainFlag(retain).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtMostOnce).Build(), ct);
        }
        catch (Exception ex) { Log?.Invoke($"Gửi {topic} lỗi: {ex.Message}"); }
    }

    async Task FlushLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(Math.Max(100, _cfg.CloudTelemetryMinMs / 4), ct); } catch (OperationCanceledException) { return; }
            foreach (var topic in _pendingTele.Keys.ToArray())
            {
                var last = _lastTele.GetOrAdd(topic, 0);
                if (last != 0 && Stopwatch.GetElapsedTime(last).TotalMilliseconds < _cfg.CloudTelemetryMinMs) continue;
                if (_pendingTele.TryRemove(topic, out var v) && State == CloudState.Connected)
                {
                    _lastTele[topic] = Stopwatch.GetTimestamp();
                    await SendAsync(topic, v.Payload, v.Retain, ct);
                }
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { if (_client.IsConnected) await _client.DisconnectAsync(); } catch { /* ignore */ }
        _client.Dispose();
    }
}
