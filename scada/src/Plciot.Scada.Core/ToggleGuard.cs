namespace Plciot.Scada;

/// <summary>
/// Chặn bật/tắt quá nhanh một đầu ra số (<see cref="PackMap.MinToggleMs"/>): relay đóng cắt dồn dập thì cháy rỗ tiếp điểm, máy nén/động cơ quá dòng khởi động.
/// Chỉ tính lần ĐỔI trạng thái: gửi lại đúng giá trị đang có (bấm "Bật" khi đã bật, script lặp lệnh) luôn được nhận và không làm lùi mốc thời gian.
/// Áp dụng cho MỌI nguồn lệnh (màn hình gateway, màn hình phụ, cloud/webapp, script qua MQTT LAN) vì cùng đi qua <see cref="ScadaCore.ExecuteKeyAsync"/>.
/// Thread-safe.
/// </summary>
public sealed class ToggleGuard
{
    sealed class Slot { public double Value; public long At; }
    readonly Dictionary<string, Slot> _last = new(StringComparer.OrdinalIgnoreCase);
    readonly Func<long> _clock;

    /// <param name="clockMs">đồng hồ đơn điệu (ms) — test truyền đồng hồ giả.</param>
    public ToggleGuard(Func<long>? clockMs = null) => _clock = clockMs ?? (() => Environment.TickCount64);

    static string Key(PackMap f) => f.Child + "\u0001" + f.WireKey;

    /// <summary>Số ms còn phải chờ trước khi được đổi <paramref name="f"/> sang <paramref name="v"/>; 0 = được ghi ngay.</summary>
    public int WaitMs(PackMap f, double v)
    {
        if (f.MinToggleMs <= 0) return 0;
        lock (_last)
        {
            if (!_last.TryGetValue(Key(f), out var s) || s.Value.Equals(v)) return 0;
            var left = s.At + f.MinToggleMs - _clock();
            return left > 0 ? (int)Math.Min(left, int.MaxValue) : 0;
        }
    }

    /// <summary>Ghi nhận lệnh đã ghi xuống thiết bị; chỉ lần ĐỔI giá trị mới đặt lại mốc thời gian.</summary>
    public void Record(PackMap f, double v)
    {
        if (f.MinToggleMs <= 0) return;
        lock (_last)
        {
            if (_last.TryGetValue(Key(f), out var s) && s.Value.Equals(v)) return;
            _last[Key(f)] = new Slot { Value = v, At = _clock() };
        }
    }

    /// <summary>Kiểm tra + giữ chỗ trong một bước (hai lệnh đến cùng lúc không cùng lọt). true = được ghi; false = <paramref name="waitMs"/> ms nữa mới được.</summary>
    public bool TryTake(PackMap f, double v, out int waitMs)
    {
        lock (_last)
        {
            waitMs = WaitMs(f, v);
            if (waitMs > 0) return false;
            Record(f, v);
            return true;
        }
    }

    /// <summary>Ghi thất bại (PLC lỗi): trả lại trạng thái trước đó để lần thử lại không bị chặn oan.</summary>
    public void Undo(PackMap f, double? prevValue, long prevAt)
    {
        lock (_last)
        {
            if (prevValue is { } pv) _last[Key(f)] = new Slot { Value = pv, At = prevAt };
            else _last.Remove(Key(f));
        }
    }

    /// <summary>Ảnh chụp trước khi giữ chỗ (để <see cref="Undo"/>).</summary>
    public (double? Value, long At) Peek(PackMap f)
    {
        lock (_last) return _last.TryGetValue(Key(f), out var s) ? (s.Value, s.At) : (null, 0);
    }
}
