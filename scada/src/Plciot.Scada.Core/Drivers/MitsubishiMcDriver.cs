using System.Buffers.Binary;
using System.Net.Sockets;

namespace Plciot.Scada;

/// <summary>
/// Mitsubishi MELSEC, giao thức MC (SLMP) khung 3E nhị phân qua TCP. Thanh ghi D n = thiết bị D (word).
/// Q/L/QnA: lệnh con 0000, số thiết bị 3 byte; iQ-R/iQ-L: lệnh con 0002, số thiết bị 4 byte, mã thiết bị 2 byte.
/// </summary>
public sealed class MitsubishiMcDriver : IRegisterDriver
{
    const byte DeviceCodeD = 0xA8;
    const int MaxWords = 120;

    readonly string _host;
    readonly int _port;
    readonly bool _iqr;
    readonly int _timeoutMs;
    readonly SemaphoreSlim _lock = new(1, 1);
    TcpClient? _tcp;
    NetworkStream? _ns;

    public MitsubishiMcDriver(string host, int port, string plcType, int timeoutMs = 2000)
    {
        _host = host;
        _port = port > 0 ? port : 5001;
        _iqr = plcType.StartsWith("iQ", StringComparison.OrdinalIgnoreCase);
        _timeoutMs = timeoutMs;
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        var res = new ushort[count];
        for (var done = 0; done < count; done += MaxWords)
        {
            var n = Math.Min(MaxWords, count - done);
            var data = await RequestAsync(0x0401, address + done, n, null, ct);
            if (data.Length != n * 2) throw new IOException("mc_bad_length");
            for (var i = 0; i < n; i++) res[done + i] = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(i * 2));
        }
        return res;
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        var payload = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(payload, value);
        await RequestAsync(0x1401, address, 1, payload, ct);
    }

    /// <summary>Dựng khung yêu cầu 3E (công khai để kiểm thử).</summary>
    public byte[] BuildRequest(ushort command, int address, int points, byte[]? writeData)
    {
        var body = new List<byte>();
        body.AddRange(new byte[] { 0x10, 0x00 });                        // monitoring timer = 4 s
        body.AddRange(BitConverter.GetBytes(command));
        body.AddRange(BitConverter.GetBytes((ushort)(_iqr ? 0x0002 : 0x0000)));
        if (_iqr)
        {
            body.AddRange(BitConverter.GetBytes((uint)address));
            body.AddRange(BitConverter.GetBytes((ushort)DeviceCodeD));
        }
        else
        {
            body.Add((byte)address); body.Add((byte)(address >> 8)); body.Add((byte)(address >> 16));
            body.Add(DeviceCodeD);
        }
        body.AddRange(BitConverter.GetBytes((ushort)points));
        if (writeData != null) body.AddRange(writeData);

        var frame = new List<byte> { 0x50, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00 };   // sub 5000, network 0, PC FF, module 03FF, station 0
        frame.AddRange(BitConverter.GetBytes((ushort)body.Count));
        frame.AddRange(body);
        return frame.ToArray();
    }

    async Task<byte[]> RequestAsync(ushort command, int address, int points, byte[]? writeData, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeoutMs);
            try
            {
                if (_ns == null)
                {
                    var tcp = new TcpClient { NoDelay = true };
                    await tcp.ConnectAsync(_host, _port, cts.Token);
                    _tcp = tcp; _ns = tcp.GetStream();
                }
                await _ns.WriteAsync(BuildRequest(command, address, points, writeData), cts.Token);
                var hdr = new byte[9];                                    // D0 00 | net pc | io(2) | station | length(2); length = end code + data
                await ReadExactAsync(hdr, 9, cts.Token);
                var len = BinaryPrimitives.ReadUInt16LittleEndian(hdr.AsSpan(7, 2));
                if (hdr[0] != 0xD0 || hdr[1] != 0x00) throw new IOException("mc_bad_header");
                var rest = new byte[len];
                await ReadExactAsync(rest, len, cts.Token);
                var end = BinaryPrimitives.ReadUInt16LittleEndian(rest);
                if (end != 0) throw new IOException($"mc_end_code_{end:X4}");
                return rest[2..];
            }
            catch
            {
                Close();
                throw;
            }
        }
        finally { _lock.Release(); }
    }

    async Task ReadExactAsync(byte[] buf, int n, CancellationToken ct)
    {
        var got = 0;
        while (got < n)
        {
            var r = await _ns!.ReadAsync(buf.AsMemory(got, n - got), ct);
            if (r == 0) throw new IOException("mc_closed");
            got += r;
        }
    }

    void Close() { try { _ns?.Dispose(); _tcp?.Dispose(); } catch { /* ignore */ } _ns = null; _tcp = null; }
    public void Dispose() { Close(); _lock.Dispose(); }
}
