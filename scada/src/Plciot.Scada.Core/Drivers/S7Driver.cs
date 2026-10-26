using S7.Net;

namespace Plciot.Scada;

/// <summary>Siemens S7 (ISO-on-TCP, thư viện S7netplus): DB chứa INT[300], thanh ghi D n = DBW(2n), big-endian.</summary>
public sealed class S7Driver : IRegisterDriver
{
    const int MaxBytes = 200;

    readonly Plc _plc;
    readonly int _db;
    readonly SemaphoreSlim _lock = new(1, 1);

    public S7Driver(string host, int port, string cpu, int rack, int slot, int db)
    {
        if (!Enum.TryParse<CpuType>(cpu, true, out var type)) throw new ArgumentException($"CPU S7 không hợp lệ: {cpu}");
        _plc = new Plc(type, host, port > 0 ? port : 102, (short)rack, (short)slot);
        _db = db;
    }

    async Task EnsureOpenAsync(CancellationToken ct)
    {
        if (!_plc.IsConnected) await _plc.OpenAsync(ct);
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await EnsureOpenAsync(ct);
            var res = new ushort[count];
            for (var done = 0; done < count; done += MaxBytes / 2)
            {
                var n = Math.Min(MaxBytes / 2, count - done);
                var bytes = await _plc.ReadBytesAsync(DataType.DataBlock, _db, (address + done) * 2, n * 2, ct);
                for (var i = 0; i < n; i++) res[done + i] = (ushort)((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
            }
            return res;
        }
        catch { try { _plc.Close(); } catch { /* ignore */ } throw; }
        finally { _lock.Release(); }
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await EnsureOpenAsync(ct);
            await _plc.WriteBytesAsync(DataType.DataBlock, _db, address * 2, new[] { (byte)(value >> 8), (byte)value }, ct);
        }
        catch { try { _plc.Close(); } catch { /* ignore */ } throw; }
        finally { _lock.Release(); }
    }

    public void Dispose() { try { _plc.Close(); } catch { /* ignore */ } _lock.Dispose(); }
}
