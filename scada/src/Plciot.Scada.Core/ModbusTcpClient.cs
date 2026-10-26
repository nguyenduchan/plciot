using System.Buffers.Binary;
using System.Net.Sockets;

namespace Plciot.Scada;

public sealed class ModbusException : Exception
{
    public ModbusException(string msg) : base(msg) { }
}

/// <summary>Modbus TCP master tối giản: FC03 (đọc holding) và FC06 (ghi một thanh ghi). Địa chỉ = số thanh ghi D.</summary>
public sealed class ModbusTcpClient : IRegisterDriver
{
    readonly string _host;
    readonly int _port;
    readonly byte _unit;
    readonly int _timeoutMs;
    readonly SemaphoreSlim _lock = new(1, 1);
    TcpClient? _tcp;
    NetworkStream? _ns;
    ushort _tid;

    public ModbusTcpClient(string host, int port, int unit, int timeoutMs = 2000)
    {
        _host = host; _port = port; _unit = (byte)unit; _timeoutMs = timeoutMs;
    }

    public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default) => ReadHoldingAsync(address, count, ct);
    public Task WriteAsync(int address, ushort value, CancellationToken ct = default) => WriteSingleAsync(address, value, ct);

    public async Task<ushort[]> ReadHoldingAsync(int address, int count, CancellationToken ct = default)
    {
        if (count is < 1 or > 125) throw new ArgumentOutOfRangeException(nameof(count));
        var pdu = new byte[5];
        pdu[0] = 3;
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(1), (ushort)address);
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(3), (ushort)count);
        var resp = await TransactAsync(pdu, ct);
        if (resp.Length != 2 + count * 2 || resp[1] != count * 2) throw new ModbusException("bad_read_length");
        var vals = new ushort[count];
        for (var i = 0; i < count; i++) vals[i] = BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(2 + i * 2));
        return vals;
    }

    public async Task WriteSingleAsync(int address, ushort value, CancellationToken ct = default)
    {
        var pdu = new byte[5];
        pdu[0] = 6;
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(1), (ushort)address);
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(3), value);
        var resp = await TransactAsync(pdu, ct);
        if (resp.Length != 5 || BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(1)) != address
            || BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(3)) != value)
            throw new ModbusException("bad_write_echo");
    }

    async Task<byte[]> TransactAsync(byte[] pdu, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeoutMs);
            try
            {
                if (_ns == null) await ConnectAsync(cts.Token);
                var req = new byte[7 + pdu.Length];
                var tid = ++_tid;
                BinaryPrimitives.WriteUInt16BigEndian(req, tid);
                BinaryPrimitives.WriteUInt16BigEndian(req.AsSpan(4), (ushort)(pdu.Length + 1));
                req[6] = _unit;
                pdu.CopyTo(req, 7);
                await _ns!.WriteAsync(req, cts.Token);

                var hdr = new byte[7];
                await ReadExactAsync(hdr, cts.Token);
                var rtid = BinaryPrimitives.ReadUInt16BigEndian(hdr);
                var len = BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(4));
                if (rtid != tid || len < 2 || len > 254) throw new ModbusException("bad_mbap");
                var body = new byte[len - 1];
                await ReadExactAsync(body, cts.Token);
                if ((body[0] & 0x80) != 0) throw new ModbusException($"exception_{body[1]}");
                if (body[0] != pdu[0]) throw new ModbusException("bad_function");
                return body;
            }
            catch (Exception e) when (e is not ModbusException)
            {
                Close();      // mất đồng bộ khung: bỏ kết nối, lần sau nối lại
                if (e is OperationCanceledException && !ct.IsCancellationRequested) throw new TimeoutException("modbus_timeout");
                throw;
            }
            catch (ModbusException)
            {
                // phản hồi sai khung → không tin cậy luồng nữa
                Close();
                throw;
            }
        }
        finally { _lock.Release(); }
    }

    async Task ConnectAsync(CancellationToken ct)
    {
        var tcp = new TcpClient { NoDelay = true };
        await tcp.ConnectAsync(_host, _port, ct);
        _tcp = tcp;
        _ns = tcp.GetStream();
    }

    async Task ReadExactAsync(byte[] buf, CancellationToken ct)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var n = await _ns!.ReadAsync(buf.AsMemory(got), ct);
            if (n == 0) throw new IOException("modbus_closed");
            got += n;
        }
    }

    void Close()
    {
        try { _ns?.Dispose(); _tcp?.Dispose(); } catch { /* ignore */ }
        _ns = null; _tcp = null;
    }

    public void Dispose() { Close(); _lock.Dispose(); }
}
