namespace Plciot.Scada;

public sealed record PackReadResult(Dictionary<(string Child, string Field), double> Values, List<string> Errors, int Groups, int FailedGroups);

/// <summary>
/// Các driver theo TỪNG field đã gán giao thức: field nào cùng giao thức + cùng thông số (Unit ID, DB, tag…) dùng chung một driver;
/// kết nối (địa chỉ, cổng) lấy từ <see cref="ScadaConfig.Connections"/>. Đọc gom các field liền kề thành một lần đọc; giải mã theo
/// kiểu dữ liệu/đảo word/hệ số của từng field. Không đọc dải nào ngoài các field đã khai báo.
/// </summary>
public sealed class PackDriverPool : IDisposable
{
    /// <summary>Gom hai field cách nhau tối đa bấy nhiêu word thành một lần đọc (chỉ để bớt round-trip, không đổi kết quả).</summary>
    const int MaxGap = 8;
    /// <summary>Số word tối đa một lần gọi đọc.</summary>
    const int MaxChunk = 100;

    readonly ScadaConfig _cfg;
    readonly Func<PlcConnection, PackMap, IRegisterDriver> _factory;
    readonly Dictionary<string, IRegisterDriver> _drivers = new();
    readonly object _gate = new();

    public PackDriverPool(ScadaConfig cfg, Func<PlcConnection, PackMap, IRegisterDriver>? factory = null)
    {
        _cfg = cfg;
        _factory = factory ?? DriverFactory.CreateFor;
    }

    /// <summary>Khoá của một PLC: giao thức + toàn bộ thông số riêng của field.</summary>
    public static string Key(PackMap p) =>
        p.Protocol + "|" + string.Join(";", p.Params.OrderBy(k => k.Key, StringComparer.Ordinal).Select(kv => kv.Key + "=" + kv.Value));

    public IRegisterDriver For(PackMap p)
    {
        lock (_gate)
        {
            var key = Key(p);
            if (_drivers.TryGetValue(key, out var d)) return d;
            var conn = _cfg.ConnectionFor(p.Source ?? throw new InvalidOperationException("field chưa gán giao thức"))
                       ?? throw new InvalidOperationException($"thiếu kết nối {p.Protocol}");
            return _drivers[key] = _factory(conn, p);
        }
    }

    /// <summary>Đọc mọi field có quyền đọc (không phải "chỉ ghi"). Một PLC lỗi chỉ làm mất các field của PLC đó.</summary>
    public async Task<PackReadResult> ReadAllAsync(CancellationToken ct = default)
    {
        var groups = _cfg.Pack.Where(p => p.Access != PackAccess.Write).GroupBy(Key).Select(g => g.ToList()).ToList();
        var results = await Task.WhenAll(groups.Select(g => ReadGroupAsync(g, ct)));
        var values = new Dictionary<(string, string), double>();
        var errors = new List<string>();
        foreach (var (vals, err) in results)
        {
            if (err != null) errors.Add(err);
            else foreach (var kv in vals) values[kv.Key] = kv.Value;
        }
        return new PackReadResult(values, errors, groups.Count, errors.Count);
    }

    async Task<(Dictionary<(string, string), double> Values, string? Error)> ReadGroupAsync(List<PackMap> items, CancellationToken ct)
    {
        var vals = new Dictionary<(string, string), double>();
        try
        {
            var drv = For(items[0]);
            var sorted = items.OrderBy(p => p.Address).ToList();
            var i = 0;
            while (i < sorted.Count)
            {
                var start = sorted[i].Address; var end = start + sorted[i].Words; var j = i + 1;
                while (j < sorted.Count && sorted[j].Address <= end + MaxGap) { end = Math.Max(end, sorted[j].Address + sorted[j].Words); j++; }
                var words = new ushort[end - start];
                for (var off = 0; off < words.Length; off += MaxChunk)
                {
                    var n = Math.Min(MaxChunk, words.Length - off);
                    var part = await drv.ReadAsync(start + off, n, ct);
                    if (part.Length < n) throw new IOException("đọc thiếu word");
                    Array.Copy(part, 0, words, off, n);
                }
                for (var k = i; k < j; k++)
                {
                    var p = sorted[k];
                    var raw = PackCodec.Decode(words.AsSpan(p.Address - start, p.Words), p.DataType, p.WordSwap);
                    vals[(p.Child, p.Field)] = Math.Round(raw / p.Scale, 3);
                }
                i = j;
            }
            return (vals, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            var p = items[0];
            return (vals, $"{ProtocolSpec.Name(p.Source!.Value)} ({string.Join(",", items.Select(x => x.Child + "." + x.Field).Take(3))}…): {ex.Message}");
        }
    }

    /// <summary>Ghi một field: giá trị kỹ thuật × hệ số → mã hoá theo kiểu → ghi các word liền nhau. Ném ArgumentOutOfRangeException nếu ngoài khoảng của kiểu.</summary>
    public Task WriteAsync(PackMap p, double value, CancellationToken ct = default)
    {
        if (p.Access == PackAccess.Read) throw new InvalidOperationException("read_only");
        var words = PackCodec.Encode(value * p.Scale, p.DataType, p.WordSwap);
        return For(p).WriteManyAsync(p.Address, words, ct);
    }

    public void Dispose()
    {
        lock (_gate) { foreach (var d in _drivers.Values) d.Dispose(); _drivers.Clear(); }
    }
}
