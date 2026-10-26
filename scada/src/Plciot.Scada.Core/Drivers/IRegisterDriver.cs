namespace Plciot.Scada;

/// <summary>
/// Một giao thức Ethernet tới PLC, nhìn dưới dạng bản đồ thanh ghi D (docs/PROTOCOL.md): đọc một dải và ghi một thanh ghi.
/// Địa chỉ là số thanh ghi D; mỗi driver tự ánh xạ sang địa chỉ của giao thức mình.
/// </summary>
public interface IRegisterDriver : IDisposable
{
    Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default);
    Task WriteAsync(int address, ushort value, CancellationToken ct = default);
}
