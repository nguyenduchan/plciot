using System.Buffers.Binary;
using System.IO.Ports;

namespace Plciot.Scada;

/// <summary>
/// Modbus RTU master trên cổng nối tiếp (USB-RS485 / COMx) — PC đọc thẳng COM2 RS485 của PLC, không qua gateway ESP32.
/// FC03 (đọc holding) và FC06 (ghi một thanh ghi); địa chỉ = số thanh ghi D, giống <see cref="ModbusTcpClient"/>.
/// Luồng được mở qua <c>opener</c> để kiểm thử không cần cổng thật.
/// </summary>
public sealed class ModbusRtuClient : IRegisterDriver
{
    readonly Func<Stream> _open;
    readonly byte _unit;
    readonly int _timeoutMs;
    readonly SemaphoreSlim _lock = new(1, 1);
    Stream? _s;

    public ModbusRtuClient(Func<Stream> opener, int unit, int timeoutMs = 1000)
    {
        _open = opener; _unit = (byte)unit; _timeoutMs = timeoutMs;
    }

    /// <summary>Mở cổng COM thật. Mặc định của PLC Xinje trong docs/PROTOCOL.md: 19200 8E1.</summary>
    public static ModbusRtuClient ForSerial(string port, int baud, string parity, int unit, int timeoutMs = 1000)
    {
        var p = Enum.Parse<Parity>(parity, ignoreCase: true);
        return new ModbusRtuClient(() =>
        {
            var sp = new SerialPort(port, baud <= 0 ? 19200 : baud, p, 8, p == Parity.None ? StopBits.Two : StopBits.One)
            { ReadTimeout = timeoutMs, WriteTimeout = timeoutMs };
            sp.Open();
            sp.DiscardInBuffer();
            return sp.BaseStream;
        }, unit, timeoutMs);
    }

    public static ushort Crc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0xFFFF;
        foreach (var b in data)
        {
            crc ^= b;
            for (var i = 0; i < 8; i++) crc = (crc & 1) != 0 ? (ushort)((crc >> 1) ^ 0xA001) : (ushort)(crc >> 1);
        }
        return crc;
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        if (count is < 1 or > 125) throw new ArgumentOutOfRangeException(nameof(count));
        var pdu = new byte[5];
        pdu[0] = 3;
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(1), (ushort)address);
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(3), (ushort)count);
        var resp = await TransactAsync(pdu, 5 + count * 2, ct);
        if (resp[2] != count * 2) throw new ModbusException("bad_read_length");
        var vals = new ushort[count];
        for (var i = 0; i < count; i++) vals[i] = BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(3 + i * 2));
        return vals;
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        var pdu = new byte[5];
        pdu[0] = 6;
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(1), (ushort)address);
        BinaryPrimitives.WriteUInt16BigEndian(pdu.AsSpan(3), value);
        var resp = await TransactAsync(pdu, 8, ct);
        if (BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(2)) != address || BinaryPrimitives.ReadUInt16BigEndian(resp.AsSpan(4)) != value)
            throw new ModbusException("bad_write_echo");
    }

    /// <summary>Gửi một khung và đọc khung trả lời (độ dài biết trước; trả lời lỗi ngoại lệ dài 5 byte). Trả về cả [unit, fc, ...].</summary>
    async Task<byte[]> TransactAsync(byte[] pdu, int expectLen, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeoutMs);
            try
            {
                _s ??= _open();
                var req = new byte[1 + pdu.Length + 2];
                req[0] = _unit;
                pdu.CopyTo(req, 1);
                BinaryPrimitives.WriteUInt16LittleEndian(req.AsSpan(req.Length - 2), Crc16(req.AsSpan(0, req.Length - 2)));
                await _s.WriteAsync(req, cts.Token);
                await _s.FlushAsync(cts.Token);

                var hdr = new byte[2];
                await ReadExactAsync(hdr, cts.Token);
                if (hdr[0] != _unit) throw new ModbusException("bad_unit");
                var exception = (hdr[1] & 0x80) != 0;
                var rest = new byte[(exception ? 5 : expectLen) - 2];
                await ReadExactAsync(rest, cts.Token);
                var frame = new byte[hdr.Length + rest.Length];
                hdr.CopyTo(frame, 0); rest.CopyTo(frame, hdr.Length);
                var crc = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(frame.Length - 2));
                if (crc != Crc16(frame.AsSpan(0, frame.Length - 2))) throw new ModbusException("bad_crc");
                if (exception) throw new ModbusException($"exception_{frame[2]}");
                if (frame[1] != pdu[0]) throw new ModbusException("bad_function");
                return frame;
            }
            catch (Exception e)
            {
                Close();      // mất đồng bộ khung / lỗi cổng: bỏ luồng, lần sau mở lại và xả bộ đệm
                if (e is OperationCanceledException && !ct.IsCancellationRequested) throw new TimeoutException("modbus_timeout");
                throw;
            }
        }
        finally { _lock.Release(); }
    }

    async Task ReadExactAsync(byte[] buf, CancellationToken ct)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var n = await _s!.ReadAsync(buf.AsMemory(got), ct);
            if (n == 0) throw new IOException("modbus_closed");
            got += n;
        }
    }

    void Close()
    {
        try { _s?.Dispose(); } catch { /* ignore */ }
        _s = null;
    }

    public void Dispose() { Close(); _lock.Dispose(); }
}
