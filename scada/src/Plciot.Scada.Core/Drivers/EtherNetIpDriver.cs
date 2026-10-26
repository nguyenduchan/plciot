using libplctag;
using libplctag.DataTypes;

namespace Plciot.Scada;

/// <summary>Rockwell/Allen-Bradley EtherNet/IP (libplctag): controller tag INT[300]; thanh ghi D n = phần tử n.</summary>
public sealed class EtherNetIpDriver : IRegisterDriver
{
    readonly string _host;
    readonly string _path;
    readonly string _tagName;
    readonly SemaphoreSlim _lock = new(1, 1);
    Tag? _image;

    public EtherNetIpDriver(string host, int slot, string tagName)
    {
        _host = host;
        _path = $"1,{slot}";
        _tagName = tagName;
    }

    Tag NewTag(string name, int count) => new()
    {
        Name = name, Gateway = _host, Path = _path, PlcType = PlcType.ControlLogix, Protocol = Protocol.ab_eip,
        Timeout = TimeSpan.FromSeconds(2), ElementSize = 2, ElementCount = count,
    };

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            // Đọc cả mảng 300 phần tử một lần, cắt dải cần dùng (ít round-trip hơn đọc từng khối)
            _image ??= NewTag(_tagName, Contract.MaxRegister);
            await _image.ReadAsync(ct);
            var res = new ushort[count];
            for (var i = 0; i < count; i++) res[i] = (ushort)_image.GetInt16((address + i) * 2);
            return res;
        }
        catch { _image?.Dispose(); _image = null; throw; }
        finally { _lock.Release(); }
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            // Tag một phần tử riêng: ghi cả mảng sẽ đè lên các giá trị PLC vừa cập nhật
            using var t = NewTag($"{_tagName}[{address}]", 1);
            t.SetInt16(0, unchecked((short)value));
            await t.WriteAsync(ct);
        }
        finally { _lock.Release(); }
    }

    public void Dispose() { _image?.Dispose(); _lock.Dispose(); }
}
