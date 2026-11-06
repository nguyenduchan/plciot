using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>Một đầu giao thức của PLC giả. Server (Modbus/MC/FINS): gateway poll và ghi lệnh vào. MQTT: PLC chủ động đẩy.</summary>
public interface IEndpoint : IAsyncDisposable
{
    string Name { get; }
    /// <summary>Số kết nối/đối tác đang hoạt động (client của server, hoặc 1 nếu MQTT đã nối broker).</summary>
    int Peers { get; }
    Task StartAsync();
    /// <summary>Gửi ngay trạng thái hiện tại tới gateway (server: chỉ ghi nhận — gateway tự đọc ở chu kỳ poll).</summary>
    Task PushAsync();
}

static class Io
{
    public static async Task<bool> ReadExact(NetworkStream ns, byte[] buf, CancellationToken ct)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var n = await ns.ReadAsync(buf.AsMemory(got), ct);
            if (n == 0) return false;
            got += n;
        }
        return true;
    }
}
