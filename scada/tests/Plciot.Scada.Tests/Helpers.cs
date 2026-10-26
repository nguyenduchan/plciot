using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using MQTTnet;
using MQTTnet.Server;

namespace Plciot.Scada.Tests;

public static class Net
{
    public static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    public static async Task<bool> WaitFor(Func<bool> cond, int ms = 8000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < end)
        {
            if (cond()) return true;
            await Task.Delay(50);
        }
        return cond();
    }
}

/// <summary>PLC giả lập Modbus TCP: 300 thanh ghi, FC03/FC06. Đủ để chạy nguyên đường dẫn Modbus → broker → cloud.</summary>
public sealed class FakeModbusPlc : IDisposable
{
    public readonly ushort[] Regs = new ushort[300];
    public int Port { get; }
    readonly TcpListener _l;
    readonly CancellationTokenSource _cts = new();

    public FakeModbusPlc()
    {
        _l = new TcpListener(IPAddress.Loopback, 0);
        _l.Start();
        Port = ((IPEndPoint)_l.LocalEndpoint).Port;
        Regs[0] = 0b101; Regs[8] = 1; Regs[14] = 7;
        _ = Task.Run(AcceptLoop);
    }

    async Task AcceptLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var c = await _l.AcceptTcpClientAsync(_cts.Token);
                _ = Task.Run(() => Serve(c));
            }
        }
        catch { /* tắt */ }
    }

    async Task Serve(TcpClient c)
    {
        using var _ = c;
        var ns = c.GetStream();
        var hdr = new byte[7];
        try
        {
            while (true)
            {
                if (!await Read(ns, hdr)) return;
                var len = BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(4));
                var pdu = new byte[len - 1];
                if (!await Read(ns, pdu)) return;
                byte[] resp;
                lock (Regs)
                {
                    var a = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(1));
                    var n = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(3));
                    if (pdu[0] == 3 && a + n <= Regs.Length)
                    {
                        resp = new byte[2 + n * 2];
                        resp[0] = 3; resp[1] = (byte)(n * 2);
                        for (var i = 0; i < n; i++) BinaryPrimitives.WriteUInt16BigEndian(resp.AsSpan(2 + i * 2), Regs[a + i]);
                    }
                    else if (pdu[0] == 6 && a < Regs.Length)
                    {
                        Regs[a] = n;
                        resp = pdu;
                    }
                    else resp = new byte[] { (byte)(pdu[0] | 0x80), 2 };
                }
                var outp = new byte[7 + resp.Length];
                hdr.AsSpan(0, 4).CopyTo(outp);
                BinaryPrimitives.WriteUInt16BigEndian(outp.AsSpan(4), (ushort)(resp.Length + 1));
                outp[6] = hdr[6];
                resp.CopyTo(outp, 7);
                await ns.WriteAsync(outp);
            }
        }
        catch { /* client đóng */ }
    }

    static async Task<bool> Read(NetworkStream ns, byte[] buf)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var n = await ns.ReadAsync(buf.AsMemory(got));
            if (n == 0) return false;
            got += n;
        }
        return true;
    }

    public ushort Get(int a) { lock (Regs) return Regs[a]; }

    public void Dispose() { _cts.Cancel(); _l.Stop(); }
}

/// <summary>Broker "cloud" giả: chỉ nhận kết nối TLS, tài khoản gw/secret, ghi lại mọi tin nhắn nhận được.</summary>
public sealed class FakeCloud : IAsyncDisposable
{
    public readonly List<(string Topic, string Payload, bool Retain)> Received = new();
    public readonly string PinSha256;
    public readonly int Port = Net.FreePort();
    public bool PlainTextAttempt;
    readonly MqttServer _server;

    public FakeCloud()
    {
        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=fake-cloud", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        san.AddIpAddress(IPAddress.Loopback); san.AddDnsName("localhost");
        req.CertificateExtensions.Add(san.Build());
        using var self = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
        var pfx = self.Export(X509ContentType.Pfx);
        using var cert = new X509Certificate2(pfx);
        PinSha256 = Convert.ToHexString(cert.GetCertHash(HashAlgorithmName.SHA256));

        var opts = new MqttServerOptionsBuilder()
            .WithoutDefaultEndpoint()
            .WithEncryptedEndpoint().WithEncryptedEndpointPort(Port)
            .WithEncryptionCertificate(pfx)
            .WithEncryptionSslProtocol(SslProtocols.Tls12 | SslProtocols.Tls13)
            .Build();
        _server = new MqttFactory().CreateMqttServer(opts);
        _server.ValidatingConnectionAsync += e =>
        {
            if (e.UserName != "gw" || e.Password != "secret") e.ReasonCode = MQTTnet.Protocol.MqttConnectReasonCode.BadUserNameOrPassword;
            return Task.CompletedTask;
        };
        _server.InterceptingPublishAsync += e =>
        {
            lock (Received)
                Received.Add((e.ApplicationMessage.Topic, Encoding.UTF8.GetString(e.ApplicationMessage.PayloadSegment), e.ApplicationMessage.Retain));
            return Task.CompletedTask;
        };
    }

    public Task StartAsync() => _server.StartAsync();

    public Task SendCmd(string baseTopic, string json) =>
        _server.InjectApplicationMessage(new InjectedMqttApplicationMessage(
            new MqttApplicationMessageBuilder().WithTopic(baseTopic + "/cmd").WithPayload(json).Build()) { SenderClientId = "phone" });

    public (string Topic, string Payload, bool Retain)[] Snapshot() { lock (Received) return Received.ToArray(); }

    public async ValueTask DisposeAsync() { await _server.StopAsync(); _server.Dispose(); }
}
