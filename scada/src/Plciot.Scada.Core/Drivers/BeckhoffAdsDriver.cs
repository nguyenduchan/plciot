using TwinCAT.Ads;

namespace Plciot.Scada;

/// <summary>
/// Beckhoff TwinCAT ADS: symbol ARRAY[0..299] OF INT (mặc định GVL_PLC.D). Cần router ADS trên máy này
/// (TwinCAT/ADS Router) và route tới PLC; thanh ghi D n = phần tử n (INT 16 bit, little-endian).
/// </summary>
public sealed class BeckhoffAdsDriver : IRegisterDriver
{
    const uint IndexGroupValueByHandle = 0xF005;

    readonly string _netId;
    readonly int _port;
    readonly string _symbol;
    readonly AdsClient _client = new();
    readonly SemaphoreSlim _lock = new(1, 1);
    uint _arrayHandle;

    public BeckhoffAdsDriver(string netId, int port, string symbol)
    {
        _netId = netId; _port = port; _symbol = symbol;
    }

    void EnsureConnected()
    {
        if (!_client.IsConnected) { _arrayHandle = 0; _client.Connect(AmsNetId.Parse(_netId), _port); }
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            return await Task.Run(() =>
            {
                EnsureConnected();
                if (_arrayHandle == 0) _arrayHandle = _client.CreateVariableHandle(_symbol);
                var buf = new byte[Contract.MaxRegister * 2];
                var read = _client.Read(IndexGroupValueByHandle, _arrayHandle, buf.AsMemory());
                if (read < (address + count) * 2) throw new IOException("ads_short_read");
                var res = new ushort[count];
                for (var i = 0; i < count; i++) res[i] = (ushort)(buf[(address + i) * 2] | (buf[(address + i) * 2 + 1] << 8));
                return res;
            }, ct);
        }
        catch { _arrayHandle = 0; throw; }
        finally { _lock.Release(); }
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await Task.Run(() =>
            {
                EnsureConnected();
                var h = _client.CreateVariableHandle($"{_symbol}[{address}]");
                try { _client.Write(IndexGroupValueByHandle, h, new[] { (byte)value, (byte)(value >> 8) }.AsMemory()); }
                finally { _client.DeleteVariableHandle(h); }
            }, ct);
        }
        finally { _lock.Release(); }
    }

    public void Dispose() { try { _client.Dispose(); } catch { /* ignore */ } _lock.Dispose(); }
}
