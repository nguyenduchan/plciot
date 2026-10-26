using System.Net;
using System.Security.Cryptography;
using System.Text;
using MQTTnet;
using MQTTnet.Protocol;
using MQTTnet.Server;

namespace Plciot.Scada;

public sealed record BrokerMessage(string Topic, byte[] Payload, bool Retain, string Sender);

/// <summary>
/// Broker MQTT nhúng, KHÔNG mã hoá, chỉ cho mạng LAN nhà máy (gateway, HMI). Chỉ nhận topic plc/&lt;site&gt;/&lt;device&gt;/*
/// và áp dụng ACL theo vai trò. Tin nhắn nội bộ (nguồn Modbus, giao diện, cầu nối cloud) đi qua <see cref="Publish"/>.
/// </summary>
public sealed class LocalBroker : IAsyncDisposable
{
    public const string InternalPrefix = "scada-";   // clientId dành riêng cho các thành phần nội bộ

    readonly ScadaConfig _cfg;
    readonly MqttServer _server;
    readonly Dictionary<string, LocalUser> _users;
    readonly Dictionary<string, LocalRole> _roleByClient = new();
    readonly object _gate = new();

    public event Action<BrokerMessage>? MessageReceived;
    public event Action<string>? Log;

    public int ClientCount { get { lock (_gate) return _roleByClient.Count; } }

    public LocalBroker(ScadaConfig cfg)
    {
        _cfg = cfg;
        _users = cfg.LocalUsers.GroupBy(u => u.User).ToDictionary(g => g.Key, g => g.First());
        var opts = new MqttServerOptionsBuilder()
            .WithDefaultEndpoint()
            .WithDefaultEndpointBoundIPAddress(IPAddress.Parse(cfg.LocalBind))
            .WithDefaultEndpointPort(cfg.LocalPort)
            .WithPersistentSessions(false)
            .WithMaxPendingMessagesPerClient(100)
            .Build();
        _server = new MqttFactory().CreateMqttServer(opts);
        _server.ValidatingConnectionAsync += OnConnecting;
        _server.ClientDisconnectedAsync += e => { lock (_gate) _roleByClient.Remove(e.ClientId); return Task.CompletedTask; };
        _server.InterceptingPublishAsync += OnPublish;
        _server.InterceptingSubscriptionAsync += OnSubscribe;
    }

    public Task StartAsync() => _server.StartAsync();
    public Task StopAsync() => _server.StopAsync();

    /// <summary>Phát một tin nhắn từ thành phần nội bộ (không qua ACL).</summary>
    public Task PublishAsync(string topic, ReadOnlyMemory<byte> payload, bool retain, string sender = InternalPrefix + "core")
    {
        var msg = new MqttApplicationMessageBuilder().WithTopic(topic).WithPayload(payload.ToArray())
            .WithRetainFlag(retain).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtMostOnce).Build();
        return _server.InjectApplicationMessage(new InjectedMqttApplicationMessage(msg) { SenderClientId = sender });
    }

    Task OnConnecting(ValidatingConnectionEventArgs e)
    {
        // clientId nội bộ chỉ dành cho tiến trình này, client bên ngoài không được mạo danh
        if (e.ClientId.StartsWith(InternalPrefix, StringComparison.Ordinal))
        {
            e.ReasonCode = MqttConnectReasonCode.ClientIdentifierNotValid;
            return Task.CompletedTask;
        }
        if (e.UserName == null || !_users.TryGetValue(e.UserName, out var u) || !SecretEquals(u.Password, e.Password))
        {
            e.ReasonCode = MqttConnectReasonCode.BadUserNameOrPassword;
            Log?.Invoke($"Từ chối kết nối nội bộ từ {e.Endpoint} (sai tài khoản)");
            return Task.CompletedTask;
        }
        lock (_gate) _roleByClient[e.ClientId] = u.Role;
        return Task.CompletedTask;
    }

    static bool SecretEquals(string expected, string? given)
    {
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        var b = SHA256.HashData(Encoding.UTF8.GetBytes(given ?? ""));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    LocalRole? RoleOf(string clientId)
    {
        lock (_gate) return _roleByClient.TryGetValue(clientId, out var r) ? r : null;
    }

    Task OnPublish(InterceptingPublishEventArgs e)
    {
        var internalSender = e.ClientId.StartsWith(InternalPrefix, StringComparison.Ordinal);
        var kind = Contract.KindOf(e.ApplicationMessage.Topic, _cfg.BaseTopic);
        if (!internalSender)
        {
            var role = RoleOf(e.ClientId);
            var allowed = kind != null && role switch
            {
                LocalRole.Device => Contract.IsUpstream(kind),
                LocalRole.Operator => kind == "cmd",
                _ => false,
            };
            if (!allowed)
            {
                e.ProcessPublish = false;
                e.Response.ReasonCode = MqttPubAckReasonCode.NotAuthorized;
                Log?.Invoke($"Chặn publish {e.ApplicationMessage.Topic} từ {e.ClientId}");
                return Task.CompletedTask;
            }
            if (e.ApplicationMessage.PayloadSegment.Count > 4096) { e.ProcessPublish = false; return Task.CompletedTask; }
        }
        if (kind != null)
        {
            MessageReceived?.Invoke(new BrokerMessage(
                e.ApplicationMessage.Topic, e.ApplicationMessage.PayloadSegment.ToArray(), e.ApplicationMessage.Retain, e.ClientId));
        }
        return Task.CompletedTask;
    }

    Task OnSubscribe(InterceptingSubscriptionEventArgs e)
    {
        if (e.ClientId.StartsWith(InternalPrefix, StringComparison.Ordinal)) return Task.CompletedTask;
        var role = RoleOf(e.ClientId);
        var kind = Contract.KindOf(e.TopicFilter.Topic, _cfg.BaseTopic);   // chỉ chấp nhận đúng từng topic, không wildcard
        var allowed = kind != null && role switch
        {
            LocalRole.Device => kind == "cmd",
            LocalRole.Monitor or LocalRole.Operator => kind != "cmd",
            _ => false,
        };
        if (!allowed)
        {
            e.ProcessSubscription = false;
            e.Response.ReasonCode = MqttSubscribeReasonCode.NotAuthorized;
        }
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        try { await _server.StopAsync(); } catch { /* ignore */ }
        _server.Dispose();
    }
}
