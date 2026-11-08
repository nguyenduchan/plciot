using System.Globalization;

namespace PlcSim;

/// <summary>
/// Trạng thái của PLC giả: ảnh thanh ghi D0–D299 (map theo docs/PROTOCOL.md) + các thiết bị con
/// <c>d.&lt;childId&gt;.&lt;field&gt;</c> (telemetry schema:2). Mọi giao thức dùng chung một model này.
/// </summary>
public sealed class PlcModel
{
    public const int Size = 300, TelemetryRegs = 40;

    readonly object _gate = new();
    readonly ushort[] _regs = new ushort[Size];
    // childId -> field -> value (giữ thứ tự thêm vào để JSON ổn định)
    readonly Dictionary<string, Dictionary<string, double>> _children = new();
    // (child, field) -> thanh ghi D mà gateway Modbus/MC/FINS/... đọc để đóng gói d.<child>.<field> = D[addr] / scale
    readonly Dictionary<(string, string), (int Addr, double Scale)> _maps = new();

    /// <summary>Ghi từ xa (gateway/webapp) hoặc từ UI. origin = "gateway" | "ui" | "sim".</summary>
    public event Action<string, string>? Changed;      // (mô tả, origin)

    public PlcModel()
    {
        _regs[0] = 0b101; _regs[3] = 0; _regs[7] = 0;
    }

    // ---- giao thức + quyền truy cập của từng luồng ----------------------------------------------
    public enum Access { Read, Write, ReadWrite }

    /// <summary>Kind = mã giao thức (modbus, mc, s7…), Param = thông số riêng của giao thức (Unit ID, số DB, tên tag…).</summary>
    /// <summary>Kiểu dữ liệu của luồng trong thanh ghi D: số word chiếm = <see cref="Words"/>. Group = tên struct (rỗng nếu là luồng đơn).</summary>
    public enum DataType { UInt16, Int16, Bool, UInt32, Int32, Float32, Float64 }

    public static int Words(DataType t) => t switch { DataType.UInt32 or DataType.Int32 or DataType.Float32 => 2, DataType.Float64 => 4, _ => 1 };

    public readonly record struct Meta(string Kind, Access Access, string Param, DataType Type = DataType.UInt16, bool WordSwap = false, string Group = "");

    // ---- mã hoá / giải mã giá trị vào các word liền nhau (word cao trước, hoặc thấp trước nếu WordSwap) ----
    static ushort[] Encode(double x, DataType t, bool swap)
    {
        ushort[] w;
        switch (t)
        {
            case DataType.UInt16: w = new[] { (ushort)Math.Clamp(Math.Round(x), 0, 65535) }; break;
            case DataType.Int16: w = new[] { unchecked((ushort)(short)Math.Clamp(Math.Round(x), short.MinValue, short.MaxValue)) }; break;
            case DataType.Bool: w = new ushort[] { (ushort)(x != 0 ? 1 : 0) }; break;
            case DataType.UInt32: { var u = (uint)Math.Clamp(Math.Round(x), 0, uint.MaxValue); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            case DataType.Int32: { var u = unchecked((uint)(int)Math.Clamp(Math.Round(x), int.MinValue, int.MaxValue)); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            case DataType.Float32: { var u = BitConverter.SingleToUInt32Bits((float)x); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            default: { var u = BitConverter.DoubleToUInt64Bits(x); w = new[] { (ushort)(u >> 48), (ushort)(u >> 32), (ushort)(u >> 16), (ushort)u }; break; }
        }
        if (swap && w.Length > 1) Array.Reverse(w);
        return w;
    }

    double Decode(int addr, DataType t, bool swap)
    {
        var n = Words(t);
        var w = new ushort[n];
        for (var i = 0; i < n; i++) w[i] = addr + i < Size ? _regs[addr + i] : (ushort)0;
        if (swap && n > 1) Array.Reverse(w);
        switch (t)
        {
            case DataType.UInt16: case DataType.Bool: return w[0];
            case DataType.Int16: return unchecked((short)w[0]);
            case DataType.UInt32: return ((uint)w[0] << 16) | w[1];
            case DataType.Int32: return unchecked((int)(((uint)w[0] << 16) | w[1]));
            case DataType.Float32: { var f = BitConverter.UInt32BitsToSingle(((uint)w[0] << 16) | w[1]); return float.IsFinite(f) ? f : 0; }
            default: { var d = BitConverter.UInt64BitsToDouble(((ulong)w[0] << 48) | ((ulong)w[1] << 32) | ((ulong)w[2] << 16) | w[3]); return double.IsFinite(d) ? d : 0; }
        }
    }

    /// <summary>Ghi giá trị field vào các thanh ghi D đã gắn (khi đang giữ khoá).</summary>
    void StoreLocked(string child, string field, double v)
    {
        if (!_maps.TryGetValue((child, field), out var m) || m.Addr < 0) return;
        _meta.TryGetValue((child, field), out var mt);
        var w = Encode(v * m.Scale, mt.Kind == null ? DataType.UInt16 : mt.Type, mt.WordSwap);
        if (m.Addr + w.Length > Size) return;
        for (var i = 0; i < w.Length; i++) _regs[m.Addr + i] = w[i];
    }

    (DataType Type, bool Swap) TypeOf((string, string) k) => _meta.TryGetValue(k, out var mt) && mt.Kind != null ? (mt.Type, mt.WordSwap) : (DataType.UInt16, false);

    readonly Dictionary<(string, string), Meta> _meta = new();

    public void SetMeta(string child, string field, Meta m) { lock (_gate) _meta[(child, field)] = m; }

    public Meta? MetaOf(string child, string field) { lock (_gate) return _meta.TryGetValue((child, field), out var m) ? m : null; }

    /// <summary>Thanh ghi D thuộc một luồng "chỉ đọc": gateway/HMI không được ghi vào.</summary>
    bool ReadOnlyAddr(int a)
    {
        foreach (var (k, m) in _maps)
            if (a >= m.Addr && a < m.Addr + Words(TypeOf(k).Type) && _meta.TryGetValue(k, out var mt) && mt.Access == Access.Read) return true;
        return false;
    }

    public ushort Get(int a) { lock (_gate) return a is >= 0 and < Size ? _regs[a] : (ushort)0; }

    public ushort[] Read(int a, int n)
    {
        var r = new ushort[n];
        lock (_gate) for (var i = 0; i < n; i++) r[i] = a + i < Size ? _regs[a + i] : (ushort)0;
        return r;
    }

    public bool InRange(int a, int n) => a >= 0 && n >= 1 && a + n <= Size;

    public void Set(int a, ushort v, string origin)
    {
        if (a is < 0 or >= Size) return;
        var denied = false;
        lock (_gate)
        {
            if (origin == "gateway" && ReadOnlyAddr(a)) { denied = true; }
            else
            {
            if (_regs[a] == v) return;
            _regs[a] = v;
            if (origin == "gateway") ApplyRegisterRules(a, v);
            foreach (var (k, m) in _maps)                  // thanh ghi đổi → field thiết bị con tương ứng đổi theo
            {
                var (ty, sw) = TypeOf(k);
                if (a >= m.Addr && a < m.Addr + Words(ty) && _children.TryGetValue(k.Item1, out var f)) f[k.Item2] = Math.Round(Decode(m.Addr, ty, sw) / m.Scale, 3);
            }
            }
        }
        if (denied) { Changed?.Invoke($"D{a} bị từ chối: luồng chỉ đọc", "denied"); return; }
        Changed?.Invoke($"D{a} = {v}", origin);
    }

    /// <summary>Phản ứng tối thiểu của PLC khi nhận lệnh: yêu cầu chạy → băng tải chạy, D9=1 xoá số đếm.</summary>
    void ApplyRegisterRules(int a, ushort v)
    {
        if (a == 6) _regs[8] = (ushort)((_regs[2] & 1) != 0 ? 3 : v == 1 ? 1 : 0);   // E-stop (D2 bit0) giữ băng tải ở trạng thái 3
        if (a == 9 && v == 1) { _regs[14] = 0; _regs[15] = 0; _regs[9] = 0; }
    }

    // ---- thiết bị con -------------------------------------------------------------------------
    public void SetField(string child, string field, double v, string origin)
    {
        if (string.IsNullOrWhiteSpace(child) || string.IsNullOrWhiteSpace(field)) return;
        lock (_gate)
        {
            if (origin == "gateway" && _meta.TryGetValue((child, field), out var mt) && mt.Access == Access.Read)
            {
                Changed?.Invoke($"d.{child}.{field} bị từ chối: luồng chỉ đọc", "denied");
                return;
            }
            if (!_children.TryGetValue(child, out var f)) _children[child] = f = new();
            f[field] = v;
            StoreLocked(child, field, v);   // hệ số = gateway chia (D = v × hệ số)
        }
        Changed?.Invoke($"d.{child}.{field} = {v.ToString(CultureInfo.InvariantCulture)}", origin);
    }

    /// <summary>Gắn field với thanh ghi D (addr &lt; 0 = bỏ gắn). Gateway đóng gói d = D[addr] / scale.</summary>
    public void MapField(string child, string field, int addr, double scale)
    {
        lock (_gate)
        {
            if (addr < 0 || scale <= 0) _maps.Remove((child, field));
            else
            {
                _maps[(child, field)] = (addr, scale);
                if (_children.TryGetValue(child, out var f) && f.TryGetValue(field, out var v)) StoreLocked(child, field, v);
            }
        }
    }

    public (int Addr, double Scale)? MapOf(string child, string field)
    {
        lock (_gate) return _maps.TryGetValue((child, field), out var m) ? m : null;
    }

    /// <summary>Thanh ghi D → "child.field" của thiết bị con đang map vào nó (null nếu không có).</summary>
    public string? FieldAt(int addr)
    {
        lock (_gate)
        {
            foreach (var (k, m) in _maps) if (addr >= m.Addr && addr < m.Addr + Words(TypeOf(k).Type)) return $"{k.Item1}.{k.Item2}";
            return null;
        }
    }

    public void RemoveField(string child, string field)
    {
        lock (_gate)
        {
            if (!_children.TryGetValue(child, out var f)) return;
            f.Remove(field);
            _maps.Remove((child, field));
            _modes.Remove((child, field));
            _meta.Remove((child, field));
            if (f.Count == 0) _children.Remove(child);
        }
    }

    public void ClearChildren() { lock (_gate) { _children.Clear(); _maps.Clear(); _modes.Clear(); _meta.Clear(); } }

    public (string Child, string Field, double Value)[] Fields()
    {
        lock (_gate) return _children.SelectMany(c => c.Value.Select(f => (c.Key, f.Key, f.Value))).ToArray();
    }

    /// <summary>Tìm field theo key (bỏ qua hoa/thường); child rỗng = bất kỳ thiết bị con nào có field đó.</summary>
    public int ApplyKeyCommand(string? child, string key, double v, string origin)
    {
        var hit = new List<(string, string)>();
        lock (_gate)
        {
            foreach (var (cid, fields) in _children)
            {
                if (!string.IsNullOrEmpty(child) && !string.Equals(cid, child, StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var fk in fields.Keys)
                    if (string.Equals(fk, key, StringComparison.OrdinalIgnoreCase)) hit.Add((cid, fk));
            }
            // thiết bị con chưa có field đó nhưng chỉ định rõ child: tạo mới
            if (hit.Count == 0 && !string.IsNullOrEmpty(child)) hit.Add((child, key));
        }
        foreach (var (c, f) in hit) SetField(c, f, v, origin);
        return hit.Count;
    }

    /// <summary>Payload telemetry duy nhất của hệ thống: {"schema":2,"r":[...],"d":{...}} (r để gateway C# + conveyor legacy).</summary>
    public string TelemetryJson()
    {
        ushort[] r; Dictionary<string, Dictionary<string, double>> d;
        lock (_gate)
        {
            r = _regs[..TelemetryRegs];
            d = _children.ToDictionary(c => c.Key, c => new Dictionary<string, double>(c.Value));
        }
        var o = new Dictionary<string, object> { ["schema"] = 2, ["r"] = r };
        if (d.Count > 0) o["d"] = d;
        return System.Text.Json.JsonSerializer.Serialize(o);
    }

    // ---- cách sinh giá trị của từng field: cố định / ngẫu nhiên / sóng sin / tăng dần----------
    public enum FieldMode { Fixed, Random, Sine, Ramp }

    /// <summary>Cài đặt sinh giá trị: khoảng Min–Max, chu kỳ sóng sin (giây), bước tăng mỗi giây (Ramp).</summary>
    public readonly record struct Gen(FieldMode Mode, double Min, double Max, double Period = 60, double Step = 1);

    readonly Dictionary<(string, string), Gen> _modes = new();
    double _genT;

    public void SetMode(string child, string field, Gen g)
    {
        if (g.Max < g.Min) g = g with { Min = g.Max, Max = g.Min };
        if (g.Period <= 0) g = g with { Period = 60 };
        lock (_gate) _modes[(child, field)] = g;
    }

    /// <summary>Chưa đặt: cố định.</summary>
    public Gen ModeOf(string child, string field)
    {
        lock (_gate) return _modes.TryGetValue((child, field), out var m) ? m : new Gen(FieldMode.Fixed, 0, 100);
    }

    /// <summary>Mỗi giây: sinh giá trị cho field ở chế độ Ngẫu nhiên / Sóng sin / Tăng dần.</summary>
    public void GenTick()
    {
        bool changed = false;
        lock (_gate)
        {
            _genT += 1;
            foreach (var ((c, f), g) in _modes.ToArray())
            {
                if (g.Mode == FieldMode.Fixed || !_children.TryGetValue(c, out var fl) || !fl.TryGetValue(f, out var cur)) continue;
                double v;
                switch (g.Mode)
                {
                    case FieldMode.Random: v = g.Min + _rnd.NextDouble() * (g.Max - g.Min); break;
                    case FieldMode.Sine: v = (g.Min + g.Max) / 2 + (g.Max - g.Min) / 2 * Math.Sin(2 * Math.PI * _genT / g.Period); break;
                    default:   // Ramp
                        v = cur + g.Step;
                        if (cur < g.Min || cur > g.Max) v = g.Min;
                        else if (g.Step >= 0 && v > g.Max) v = g.Min;
                        else if (g.Step < 0 && v < g.Min) v = g.Max;
                        break;
                }
                PutLocked(c, f, Math.Round(v, 2));
                changed = true;
            }
        }
        if (changed) Changed?.Invoke("sim gen", "sim");
    }

    readonly Random _rnd = new(7);

    /// <summary>Ghi giá trị field (và thanh ghi D đã gắn) khi đang giữ khoá.</summary>
    void PutLocked(string child, string field, double v)
    {
        if (!_children.TryGetValue(child, out var f)) _children[child] = f = new();
        f[field] = v;
        StoreLocked(child, field, v);
    }

    /// <summary>Mô phỏng băng tải đơn giản: đang chạy thì đếm sản phẩm, đủ D7 thì dừng.</summary>
    public void SimTick()
    {
        GenTick();
        bool changed = false;
        lock (_gate)
        {
            if (_regs[8] != 1) return;
            var cnt = _regs[14] + _regs[15] * 65536L + 1;
            var tot = _regs[16] + _regs[17] * 65536L + 1;
            _regs[14] = (ushort)cnt; _regs[15] = (ushort)(cnt >> 16);
            _regs[16] = (ushort)tot; _regs[17] = (ushort)(tot >> 16);
            var run = _regs[10] + _regs[11] * 65536L + 1;
            _regs[10] = (ushort)run; _regs[11] = (ushort)(run >> 16);
            if (_regs[7] != 0 && cnt >= _regs[7]) { _regs[8] = 2; _regs[6] = 0; }
            changed = true;
        }
        if (changed) Changed?.Invoke("sim tick", "sim");
    }
}
