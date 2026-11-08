using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Cách hiển thị một field (giao diện chạy offline nên tự suy từ tên field, không cần server). Người dùng sửa được khi thêm/sửa thiết bị.</summary>
public sealed class FieldMeta
{
    /// <summary>auto | tank | gauge | toggle | slider | number</summary>
    public string Kind { get; set; } = "auto";
    public string Unit { get; set; } = "";
    public string Title { get; set; } = "";
    public double? Min { get; set; }
    public double? Max { get; set; }
    /// <summary>Chữ khi giá trị = 1 / 0 (công tắc), ví dụ "Đang chạy" / "Dừng", "Mở" / "Đóng".</summary>
    public string OnText { get; set; } = "";
    public string OffText { get; set; } = "";
    /// <summary>Ngưỡng cảnh báo thấp / cao (bồn: đổi màu và hiện chữ "Mức thấp"/"Mức cao").</summary>
    public double? Low { get; set; }
    public double? High { get; set; }

    public static readonly string[] Kinds = { "auto", "tank", "gauge", "toggle", "slider", "number" };
    public static readonly string[] KindNames = { "Tự động", "Bồn nước", "Đồng hồ", "Công tắc", "Thanh trượt", "Số lớn" };

    public sealed record Resolved(string Kind, string Unit, double Min, double Max, string Title, string OnText, string OffText, double? Low, double? High);

    /// <summary>Gộp metadata người dùng đặt với suy luận theo tên field.</summary>
    public static Resolved ResolveFull(PackMap p, FieldMeta? m)
    {
        var f = p.Field.ToLowerInvariant();
        var (kind, unit, min, max) = f switch
        {
            "level" or "lvl" or "tank" => ("tank", "%", 0d, 100d),
            "run" or "on" or "v" or "enable" or "start" or "pump" => ("toggle", "", 0d, 1d),
            "speed" or "sp" or "setpoint" or "freq" or "rpm_sp" => ("slider", "%", 0d, 100d),
            "flow" => ("gauge", "L/phút", 0d, 100d),
            "t" or "temp" or "temperature" => ("gauge", "°C", 0d, 100d),
            "h" or "hum" or "humidity" => ("gauge", "%", 0d, 100d),
            "p" or "pressure" or "bar" => ("gauge", "bar", 0d, 10d),
            "kw" or "power" => ("gauge", "kW", 0d, 100d),
            "rpm" => ("gauge", "rpm", 0d, 3000d),
            "hours" => ("number", "h", 0d, 100d),
            _ => ("number", "", 0d, 100d),
        };
        if (m != null && m.Kind != "auto") kind = m.Kind;
        if (!string.IsNullOrEmpty(m?.Unit)) unit = m!.Unit;
        min = m?.Min ?? p.Min ?? min; max = m?.Max ?? p.Max ?? max;
        var title = string.IsNullOrWhiteSpace(m?.Title) ? p.Field : m!.Title;
        var on = string.IsNullOrEmpty(m?.OnText) ? "Bật" : m!.OnText;
        var off = string.IsNullOrEmpty(m?.OffText) ? "Tắt" : m!.OffText;
        return new Resolved(kind, unit, min, max, title, on, off, m?.Low, m?.High);
    }

    public static (string Kind, string Unit, double Min, double Max, string Title) Resolve(PackMap p, FieldMeta? m)
    {
        var r = ResolveFull(p, m);
        return (r.Kind, r.Unit, r.Min, r.Max, r.Title);
    }
}

/// <summary>Thông tin cấp thiết bị: tên hiển thị và loại thiết bị vật lý (để hiện icon/mô tả).</summary>
public sealed class DeviceMeta
{
    public string Title { get; set; } = "";
    public string Template { get; set; } = "";
}

/// <summary>Lưu metadata hiển thị cạnh file cấu hình gateway.</summary>
public sealed class UiMetaStore
{
    sealed class FileModel
    {
        public Dictionary<string, FieldMeta> Fields { get; set; } = new();
        public Dictionary<string, DeviceMeta> Devices { get; set; } = new();
    }

    readonly string _path;
    /// <summary>false (chế độ demo): chỉ giữ trong bộ nhớ, không ghi file.</summary>
    public bool Persist { get; set; } = true;
    public Dictionary<string, FieldMeta> Map { get; private set; } = new();
    public Dictionary<string, DeviceMeta> Devices { get; private set; } = new();

    public UiMetaStore(string settingsPath)
    {
        _path = Path.ChangeExtension(settingsPath, ".ui.json");
        try
        {
            if (File.Exists(_path))
            {
                var m = JsonSerializer.Deserialize<FileModel>(File.ReadAllText(_path));
                if (m != null) { Map = m.Fields ?? new(); Devices = m.Devices ?? new(); }
            }
        }
        catch (Exception e) when (e is IOException or JsonException) { Map = new(); Devices = new(); }
    }

    /// <summary>Đọc lại từ file (bỏ metadata tạm của chế độ demo).</summary>
    public void Reload()
    {
        Map = new(); Devices = new();
        try
        {
            if (File.Exists(_path))
            {
                var m = JsonSerializer.Deserialize<FileModel>(File.ReadAllText(_path));
                if (m != null) { Map = m.Fields ?? new(); Devices = m.Devices ?? new(); }
            }
        }
        catch (Exception e) when (e is IOException or JsonException) { /* giữ rỗng */ }
    }

    public static string Key(string child, string field) => child + "." + field;
    public FieldMeta? Get(string child, string field) => Map.TryGetValue(Key(child, field), out var m) ? m : null;
    public DeviceMeta? Device(string child) => Devices.TryGetValue(child, out var d) ? d : null;
    public void Set(string child, string field, FieldMeta m) { Map[Key(child, field)] = m; Save(); }
    public void SetDevice(string child, DeviceMeta d) { Devices[child] = d; Save(); }
    public void Remove(string child, string field) { if (Map.Remove(Key(child, field))) Save(); }
    public void RemoveDevice(string child) { if (Devices.Remove(child)) Save(); }

    public void Save()
    {
        if (!Persist) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
            File.WriteAllText(_path, JsonSerializer.Serialize(new FileModel { Fields = Map, Devices = Devices }, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (IOException) { /* không quan trọng */ }
    }
}

/// <summary>Lịch sử giá trị trong bộ nhớ (6 giờ gần nhất, 1 mẫu/giây) cho biểu đồ.</summary>
public sealed class HistoryStore
{
    const int MaxPoints = 21600;
    readonly object _gate = new();
    readonly Dictionary<string, List<(DateTime T, double V)>> _d = new();

    public void Add(string key, double v, DateTime? at = null)
    {
        var t = at ?? DateTime.Now;
        lock (_gate)
        {
            if (!_d.TryGetValue(key, out var l)) _d[key] = l = new();
            if (l.Count > 0 && (t - l[^1].T).TotalMilliseconds < 900) return;
            l.Add((t, v));
            if (l.Count > MaxPoints) l.RemoveRange(0, l.Count - MaxPoints);
        }
    }

    public List<(DateTime T, double V)> Get(string key, int windowSec)
    {
        var t0 = DateTime.Now.AddSeconds(-windowSec);
        lock (_gate)
        {
            if (!_d.TryGetValue(key, out var l)) return new();
            var i = l.FindIndex(x => x.T >= t0);
            return i < 0 ? new() : l.GetRange(i, l.Count - i);
        }
    }

    public void Clear() { lock (_gate) _d.Clear(); }
}

/// <summary>
/// PLC giả chạy ngay trong chương trình (chế độ Demo, không cần PlcSim/phần cứng, không cần mạng):
/// bồn nước dao động + bơm đặt tốc độ. Địa chỉ lấy theo Pack: level, run, speed, flow, hours.
/// </summary>
public sealed class DemoDriver : IRegisterDriver
{
    readonly ushort[] _r = new ushort[Contract.MaxRegister];
    readonly ScadaConfig _cfg;
    readonly Random _rnd = new(11);
    readonly object _gate = new();
    DateTime _last = DateTime.UtcNow;
    double _level = 55, _t, _hours, _temp = 27, _hum = 60;

    public DemoDriver(ScadaConfig cfg)
    {
        _cfg = cfg;
        lock (_gate) { Set("run", 1); Set("speed", 35); }
    }

    /// <summary>Pack mặc định cho demo: bồn nước + bơm + cảm biến (khớp PlcSim: D50…).</summary>
    public static List<PackMap> DemoPack() => new()
    {
        new() { Child = "tank1", Field = "level", Address = 50, Scale = 10 },
        new() { Child = "pump1", Field = "run", Address = 51, Scale = 1, Min = 0, Max = 1 },
        new() { Child = "pump1", Field = "speed", Address = 52, Scale = 10, Min = 0, Max = 100 },
        new() { Child = "pump1", Field = "hours", Address = 53, Scale = 10 },
        new() { Child = "pump1", Field = "flow", Address = 54, Scale = 10 },
        new() { Child = "env1", Field = "t", Address = 55, Scale = 10 },
        new() { Child = "env1", Field = "h", Address = 56, Scale = 10 },
    };

    static readonly (string Child, string Tpl)[] SampleDevices = { ("tank1", "tank"), ("pump1", "pump"), ("env1", "env") };

    /// <summary>Nạp bộ mẫu bồn nước + bơm + cảm biến cùng nhãn/đơn vị/chữ trạng thái của từng loại thiết bị.</summary>
    public static void InstallSample(ScadaConfig cfg, UiMetaStore meta)
    {
        cfg.Pack.Clear(); cfg.Pack.AddRange(DemoPack());
        foreach (var (child, tplId) in SampleDevices)
        {
            var t = DeviceTemplate.Find(tplId)!;
            meta.SetDevice(child, new DeviceMeta { Title = t.DefaultTitle, Template = t.Id });
            foreach (var f in t.Fields)
                meta.Set(child, f.Field, new FieldMeta { Kind = f.Kind, Unit = f.Unit, Title = f.Label, OnText = f.On, OffText = f.Off, Low = f.Low, High = f.High });
        }
    }

    /// <summary>Pack hiện tại đúng là bộ mẫu (để dọn khi tắt demo).</summary>
    public static bool IsSample(ScadaConfig cfg) =>
        cfg.Pack.Count == DemoPack().Count && cfg.Pack.Zip(DemoPack()).All(x => x.First.Child == x.Second.Child && x.First.Field == x.Second.Field && x.First.Address == x.Second.Address);

    PackMap? Find(string field) => _cfg.Pack.FirstOrDefault(x => x.Field == field);
    double Get(string field) { var m = Find(field); return m == null ? 0 : _r[m.Address] / m.Scale; }
    void Set(string field, double v) { var m = Find(field); if (m != null) _r[m.Address] = (ushort)Math.Clamp(Math.Round(v * m.Scale), 0, 65535); }

    void Step()
    {
        var now = DateTime.UtcNow; var dt = Math.Clamp((now - _last).TotalSeconds, 0, 2); _last = now; _t += dt;
        var eff = Get("run") >= 1 ? Math.Clamp(Get("speed"), 0, 100) : 0;
        var inflow = 0.9 + 0.3 * Math.Sin(_t / 15) + (_rnd.NextDouble() - .5) * .1;
        _level = Math.Clamp(_level + (inflow - (_level > .5 ? eff * .025 : 0)) * dt, 0, 100);
        _temp += (_rnd.NextDouble() - .5) * .15 + (27 - _temp) * .01;
        _hum += (_rnd.NextDouble() - .5) * .3 + (60 - _hum) * .01;
        if (eff > 0) _hours += dt / 3600;
        Set("level", _level); Set("flow", _level > .5 ? eff * .8 : 0); Set("hours", _hours); Set("t", _temp); Set("h", _hum);
    }

    public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        lock (_gate)
        {
            Step();
            var r = new ushort[count];
            for (var i = 0; i < count; i++) r[i] = address + i < _r.Length ? _r[address + i] : (ushort)0;
            return Task.FromResult(r);
        }
    }

    public Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        lock (_gate) { if (address is >= 0 and < Contract.MaxRegister) _r[address] = value; }
        return Task.CompletedTask;
    }

    public void Dispose() { }
}
