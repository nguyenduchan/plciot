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
        lock (_gate)
        {
            if (_regs[a] == v) return;
            _regs[a] = v;
            if (origin == "gateway") ApplyRegisterRules(a, v);
            foreach (var (k, m) in _maps)                  // thanh ghi đổi → field thiết bị con tương ứng đổi theo
                if (m.Addr == a && _children.TryGetValue(k.Item1, out var f)) f[k.Item2] = Math.Round(v / m.Scale, 3);
        }
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
            if (!_children.TryGetValue(child, out var f)) _children[child] = f = new();
            f[field] = v;
            if (_maps.TryGetValue((child, field), out var m) && m.Addr is >= 0 and < Size)
                _regs[m.Addr] = (ushort)Math.Clamp(Math.Round(v * m.Scale), 0, 65535);   // scale ở đây = hệ số gateway chia (D = v × scale)
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
                if (_children.TryGetValue(child, out var f) && f.TryGetValue(field, out var v))
                    _regs[addr] = (ushort)Math.Clamp(Math.Round(v * scale), 0, 65535);
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
            foreach (var (k, m) in _maps) if (m.Addr == addr) return $"{k.Item1}.{k.Item2}";
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
            if (f.Count == 0) _children.Remove(child);
        }
    }

    public void ClearChildren() { lock (_gate) { _children.Clear(); _maps.Clear(); _modes.Clear(); } }

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

    // ---- cách sinh giá trị của từng field: cố định / ngẫu nhiên / sóng sin / tăng dần / mô phỏng bồn nước ----------
    public enum FieldMode { Fixed, Random, Sim, Sine, Ramp }

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

    /// <summary>Chưa đặt: level/flow/hours chạy theo mô phỏng bồn khi có đủ level + speed; còn lại cố định.</summary>
    public Gen ModeOf(string child, string field)
    {
        lock (_gate)
        {
            if (_modes.TryGetValue((child, field), out var m)) return m;
            var water = field is "level" or "flow" or "hours" && ChildWith("level") != null && ChildWith("speed") != null;
            return new Gen(water ? FieldMode.Sim : FieldMode.Fixed, 0, 100);
        }
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
                if (g.Mode is FieldMode.Fixed or FieldMode.Sim || !_children.TryGetValue(c, out var fl) || !fl.TryGetValue(f, out var cur)) continue;
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

    // ---- mô phỏng bồn nước + bơm -----------------------------------------------------------------
    double _waterT;
    readonly Random _rnd = new(7);

    /// <summary>Ghi giá trị field (và thanh ghi D đã gắn) khi đang giữ khoá.</summary>
    void PutLocked(string child, string field, double v)
    {
        if (!_children.TryGetValue(child, out var f)) _children[child] = f = new();
        f[field] = v;
        if (_maps.TryGetValue((child, field), out var m) && m.Addr is >= 0 and < Size)
            _regs[m.Addr] = (ushort)Math.Clamp(Math.Round(v * m.Scale), 0, 65535);
    }

    string? ChildWith(string field)
    {
        foreach (var (cid, fields) in _children) if (fields.ContainsKey(field)) return cid;
        return null;
    }

    /// <summary>
    /// Bồn nước: nước vào dao động quanh 0,9 %/s, bơm hút ra theo tốc độ (0–100 % → tối đa 2,5 %/s) và chỉ chạy khi run = 1 (nếu có).
    /// Cân bằng quanh tốc độ 35–45 %. Tốc độ bơm là field "speed" do webapp/gateway ghi; mức là field "level".
    /// Chạy mỗi giây từ SimTick khi bật "Mô phỏng". Không có child có field level + speed thì không làm gì.
    /// </summary>
    public void WaterTick()
    {
        bool changed = false;
        lock (_gate)
        {
            var tank = ChildWith("level"); var pump = ChildWith("speed");
            if (tank == null || pump == null) return;
            _waterT += 1;
            var speed = Math.Clamp(_children[pump]["speed"], 0, 100);
            var running = !_children[pump].TryGetValue("run", out var run) || run >= 1;
            var eff = running ? speed : 0;
            var level = _children[tank]["level"];
            var inflow = 0.9 + 0.3 * Math.Sin(_waterT / 15.0) + (_rnd.NextDouble() - 0.5) * 0.1;
            var outflow = level > 0.5 ? eff * 0.025 : 0;
            level = Math.Round(Math.Clamp(level + inflow - outflow, 0, 100), 2);
            bool Sim(string c, string f) => !_modes.TryGetValue((c, f), out var m) || m.Mode == FieldMode.Sim;   // đang giữ khoá: không gọi ModeOf
            if (Sim(tank, "level")) PutLocked(tank, "level", level);
            if (_children[pump].ContainsKey("flow") && Sim(pump, "flow")) PutLocked(pump, "flow", Math.Round(level > 0.5 ? eff * 0.8 : 0, 1));
            if (_children[pump].TryGetValue("hours", out var h) && eff > 0 && Sim(pump, "hours")) PutLocked(pump, "hours", Math.Round(h + 1.0 / 3600, 3));
            changed = true;
        }
        if (changed) Changed?.Invoke("sim water", "sim");
    }

    /// <summary>Mô phỏng băng tải đơn giản: đang chạy thì đếm sản phẩm, đủ D7 thì dừng.</summary>
    public void SimTick()
    {
        WaterTick();
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
