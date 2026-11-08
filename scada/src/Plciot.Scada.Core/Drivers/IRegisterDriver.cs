namespace Plciot.Scada;

/// <summary>
/// Một giao thức Ethernet tới PLC, nhìn dưới dạng bản đồ thanh ghi D (docs/PROTOCOL.md): đọc một dải và ghi một thanh ghi.
/// Địa chỉ là số thanh ghi D; mỗi driver tự ánh xạ sang địa chỉ của giao thức mình.
/// </summary>
public interface IRegisterDriver : IDisposable
{
    Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default);
    Task WriteAsync(int address, ushort value, CancellationToken ct = default);

    /// <summary>Ghi nhiều word liền nhau (kiểu 32/64-bit). Mặc định ghi lần lượt từng word; driver có lệnh ghi nhiều thanh ghi có thể ghi đè.</summary>
    async Task WriteManyAsync(int address, ushort[] values, CancellationToken ct = default)
    {
        for (var i = 0; i < values.Length; i++) await WriteAsync(address + i, values[i], ct);
    }
}
