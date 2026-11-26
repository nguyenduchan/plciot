using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Plciot.Scada;

// CHƯƠNG TRÌNH LOGIC của gateway PC — cùng hợp đồng JSON với board Waveshare (gateway-mcu/src/offline.cpp, docs/GATEWAY-LOGIC.md),
// khác ở chỗ đầu ra là FIELD ghi được ("Out": "<thiết bị>.<field>", tên field nội bộ — không phải khoá MQTT) thay cho số DO,
// điều kiện và "follow" theo field (không có DI). Một chương trình / gateway, thay trọn gói (Rev + Sha).
//   Need/NeedHold/Block/MaxOnSec/Timer  LUÔN chạy, mọi nguồn lệnh (đi qua ScadaCore.ExecuteKeyAsync).
//   Mode + DelaySec                     khi MẤT MẠNG (cloud đã bật mà không nối được) quá DelaySec.
// Lệnh TẮT luôn được phép; logic ghi bằng ControlSource.Logic, vẫn qua chặn bật/tắt quá nhanh (ToggleGuard) và giới hạn Min/Max.

public sealed class LogicCond
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Field { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Op { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Val { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? MaxAgeSec { get; set; }
}

public sealed class LogicTimer
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? On { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Off { get; set; }
    /// <summary>1 = thứ Hai … 7 = Chủ nhật; null = mọi ngày. Rỗng CHỈ khi chạy 1 lần (<see cref="Date"/>): gateway cũ không hiểu Date sẽ từ chối.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<int>? Days { get; set; }
    /// <summary>CHẠY 1 LẦN (kiểu báo thức iPhone): "YYYY-MM-DD" theo giờ địa phương của chương trình. Giờ tắt nhỏ hơn giờ bật = sang hôm sau.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Date { get; set; }
}

public sealed class LogicRule
{
    public string Out { get; set; } = "";
    /// <summary>hold | off | on | schedule | follow | threshold | cycle (khi mất mạng).</summary>
    public string Mode { get; set; } = "hold";
    public int DelaySec { get; set; } = 60;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? From { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? To { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Field { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Invert { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? On { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Off { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? MaxAgeSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? OnSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? OffSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<LogicCond>? Need { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? NeedHold { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<string>? Block { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? MaxOnSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<LogicTimer>? Timer { get; set; }
}

public sealed class LogicProgram
{
    public uint Rev { get; set; }
    public int TzMin { get; set; } = 420;
    public List<LogicRule> Do { get; set; } = new();
}

/// <summary>Một lần ghi do chương trình quyết định (ScadaCore thực hiện qua ExecuteKeyAsync với ControlSource.Logic).</summary>
public sealed record LogicWrite(PackMap Field, double Value, string Why);

public sealed class GatewayLogic
{
    static readonly string[] Modes = { "hold", "off", "on", "schedule", "follow", "threshold", "cycle" };
    public static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    sealed class Rt { public bool Active, Manual, Thr; public long Since, OnSince, LastTry; public double LastVal = double.NaN; public string Note = "", GuardWhy = ""; }

    readonly ScadaConfig _cfg;
    readonly Func<DateTimeOffset> _now;
    readonly Func<long> _mono;
    readonly object _gate = new();
    LogicProgram _prog = new();
    readonly Dictionary<string, Rt> _rt = new(StringComparer.Ordinal);
    Dictionary<string, HashSet<string>> _blk = new(StringComparer.Ordinal);
    long _downSince = -1;
    int _lastMin = -1;

    /// <param name="now">giờ thật (test truyền đồng hồ giả)</param><param name="monoMs">đồng hồ đơn điệu ms</param>
    public GatewayLogic(ScadaConfig cfg, Func<DateTimeOffset>? now = null, Func<long>? monoMs = null)
    {
        _cfg = cfg; _now = now ?? (() => DateTimeOffset.UtcNow); _mono = monoMs ?? (() => Environment.TickCount64);
    }

    /// <summary>Giá trị mới nhất "child.field" và tuổi (ms). Value = null: chưa đọc được.</summary>
    public Func<string, (double? Value, long AgeMs)> ValueOf { get; set; } = _ => (null, long.MaxValue);
    /// <summary>Đường cloud: true = đang nối, false = mất, null = không dùng cloud (không bao giờ "mất mạng").</summary>
    public Func<bool?> LinkUp { get; set; } = () => null;
    /// <summary>Thử mất mạng (kỹ thuật viên tại chỗ): coi như mất mạng ngay, bỏ qua thời gian chờ, tới mốc này (ms đơn điệu).</summary>
    long _testUntil;
    public event Action<string>? Log;

    public uint Rev { get { lock (_gate) return _prog.Rev; } }
    public string Sha { get; private set; } = "";
    public bool Empty { get { lock (_gate) return _prog.Do.Count == 0; } }
    public LogicProgram Program { get { lock (_gate) return Clone(_prog); } }

    static LogicProgram Clone(LogicProgram p) => JsonSerializer.Deserialize<LogicProgram>(JsonSerializer.Serialize(p, Json), Json)!;
    public static string ShaOf(LogicProgram p) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(p, Json)))).ToLowerInvariant();

    PackMap? OutField(string key) => _cfg.Pack.FirstOrDefault(p => p.Child + "." + p.Field == key && p.Access != PackAccess.Read);
    bool Readable(string key) => _cfg.Pack.Any(p => p.Child + "." + p.Field == key && p.Access != PackAccess.Write);

    static int Hhmm(string? s)
    {
        if (s == null || !TimeOnly.TryParseExact(s.Trim(), "H:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var t)) return -1;
        return t.Hour * 60 + t.Minute;
    }

    /// <summary>Kiểm chương trình theo cấu hình hiện tại. null = hợp lệ, còn lại câu báo lỗi tiếng Việt (GatewayAdmin / webapp hiện nguyên văn).</summary>
    public string? Validate(LogicProgram p)
    {
        if (p.TzMin is < -720 or > 840) return "Múi giờ không hợp lệ.";
        if (p.Do.Count > 32) return "Tối đa 32 đầu ra trong một chương trình.";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in p.Do)
        {
            var w = r.Out;
            if (string.IsNullOrWhiteSpace(r.Out)) return "Thiếu đầu ra (Out).";
            if (OutField(r.Out) == null) return $"{w}: không có trong cấu hình hoặc là field chỉ đọc.";
            if (!seen.Add(r.Out)) return $"{w} bị khai hai lần.";
            if (!Modes.Contains(r.Mode)) return $"{w}: kiểu khi mất mạng không hợp lệ.";
            if (r.DelaySec is < 0 or > 86400) return $"{w}: thời gian chờ phải từ 0 đến 86400 giây.";
            switch (r.Mode)
            {
                case "schedule":
                    int a = Hhmm(r.From), b = Hhmm(r.To);
                    if (a < 0 || b < 0) return $"{w}: giờ bật/tắt phải dạng HH:MM.";
                    if (a == b) return $"{w}: giờ bật và giờ tắt phải khác nhau.";
                    break;
                case "follow":
                    if (r.Field == null || !Readable(r.Field)) return $"{w}: follow cần field đọc được có trong cấu hình.";
                    break;
                case "threshold":
                    if (r.Field == null || !Readable(r.Field)) return $"{w}: giá trị \"{r.Field}\" không có trong cấu hình (hoặc là field chỉ ghi).";
                    if (r.On is not { } on || r.Off is not { } off) return $"{w}: cần ngưỡng bật và ngưỡng tắt.";
                    if (on == off) return $"{w}: ngưỡng bật và ngưỡng tắt phải khác nhau (để có khoảng trễ).";
                    if (r.MaxAgeSec is < 1 or > 86400) return $"{w}: thời gian mất số liệu phải từ 1 đến 86400 giây.";
                    break;
                case "cycle":
                    if (r.OnSec is not (>= 1 and <= 86400) || r.OffSec is not (>= 1 and <= 86400)) return $"{w}: thời gian bật / nghỉ phải từ 1 giây đến 24 giờ.";
                    break;
            }
            if (r.Need is { Count: > 4 }) return $"{w}: tối đa 4 điều kiện cho phép bật.";
            foreach (var c in r.Need ?? new())
            {
                if (c.Field == null || !Readable(c.Field)) return $"{w}: điều kiện \"{c.Field}\" không có trong cấu hình (hoặc là field chỉ ghi).";
                if (c.Op is not (">=" or "<=")) return $"{w}: điều kiện chỉ dùng >= hoặc <=.";
                if (c.Val == null) return $"{w}: điều kiện thiếu ngưỡng.";
                if (c.MaxAgeSec is < 1 or > 86400) return $"{w}: thời gian mất số liệu phải từ 1 đến 86400 giây.";
            }
            if (r.NeedHold == true && (r.Need == null || r.Need.Count == 0)) return $"{w}: \"tự tắt khi mất điều kiện\" cần ít nhất một điều kiện.";
            foreach (var b in r.Block ?? new()) if (b == r.Out || OutField(b) == null) return $"{w}: liên động \"{b}\" phải là đầu ra khác có trong cấu hình.";
            if (r.MaxOnSec is < 0 or > 604800) return $"{w}: thời gian chạy tối đa phải từ 0 đến 604800 giây (7 ngày).";
            if (r.Timer is { Count: > 4 }) return $"{w}: tối đa 4 mốc hẹn giờ.";
            foreach (var t in r.Timer ?? new())
            {
                int on = t.On == null ? -1 : Hhmm(t.On), off = t.Off == null ? -1 : Hhmm(t.Off);
                if ((t.On != null && on < 0) || (t.Off != null && off < 0)) return $"{w}: giờ hẹn giờ phải dạng HH:MM.";
                if (on < 0 && off < 0) return $"{w}: mốc hẹn giờ cần giờ bật hoặc giờ tắt.";
                if (on == off) return $"{w}: giờ bật và giờ tắt của hẹn giờ phải khác nhau.";
                if (t.Date != null)
                {
                    if (!DateOnly.TryParseExact(t.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return $"{w}: ngày hẹn giờ phải dạng YYYY-MM-DD.";
                    if (t.Days is { Count: > 0 }) return $"{w}: hẹn giờ 1 lần không kèm ngày lặp lại.";
                }
                else if (t.Days != null && (t.Days.Count == 0 || t.Days.Any(d => d is < 1 or > 7))) return $"{w}: ngày hẹn giờ phải từ 1 (thứ Hai) đến 7 (Chủ nhật).";
            }
        }
        return null;
    }

    /// <summary>Nạp chương trình đã kiểm (khởi động: từ file; sau PUT). Trạng thái chạy về đầu.</summary>
    public void Load(LogicProgram p)
    {
        lock (_gate)
        {
            _prog = Clone(p);
            Sha = ShaOf(_prog);
            _rt.Clear();
            var blk = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            foreach (var r in _prog.Do)
                foreach (var b in r.Block ?? new())
                {
                    (blk.TryGetValue(r.Out, out var x) ? x : blk[r.Out] = new()).Add(b);
                    (blk.TryGetValue(b, out var y) ? y : blk[b] = new()).Add(r.Out);   // liên động hai chiều
                }
            _blk = blk;
        }
    }

    Rt R(string key) => _rt.TryGetValue(key, out var r) ? r : _rt[key] = new Rt();
    LogicRule? RuleOf(string key) => _prog.Do.FirstOrDefault(r => r.Out == key);
    bool IsOn(string key) => StateOf(key) == true;

    /// <summary>Giá trị đọc cũ hơn ngần này (ms) = KHÔNG RÕ trạng thái: thiết bị RS485 / Modbus TCP mất kết nối (giá trị cuối vẫn còn trong bộ nhớ).</summary>
    public long StaleMs => Math.Max(10_000, _cfg.PollMs * 5L);

    /// <summary>
    /// Trạng thái đầu ra: true = bật, false = tắt, null = KHÔNG RÕ (chưa đọc được / thiết bị mất kết nối quá <see cref="StaleMs"/>).
    /// Field CHỈ GHI (không đọc lại được, vd cuộn coil của biến tần) → theo giá trị ghi gần nhất (ScadaCore ghi vào ValueOf ngay khi ghi xong).
    /// </summary>
    public bool? StateOf(string key)
    {
        var (v, age) = ValueOf(key);
        if (v == null) return null;
        var f = _cfg.Pack.FirstOrDefault(p => p.Child + "." + p.Field == key);
        if (f?.Access != PackAccess.Write && age > StaleMs) return null;
        return v != 0;
    }

    static string CondText(LogicCond c) => $"{c.Field} {(c.Op == ">=" ? "≥" : "≤")} {c.Val?.ToString(CultureInfo.InvariantCulture)}";
    string? FailedCond(LogicRule r)
    {
        foreach (var c in r.Need ?? new())
        {
            var (v, age) = ValueOf(c.Field!);
            if (v == null || age > (c.MaxAgeSec ?? 60) * 1000L) return CondText(c) + " (mất số liệu)";
            if (c.Op == ">=" ? v < c.Val : v > c.Val) return CondText(c);
        }
        return null;
    }

    /// <summary>
    /// Chặn lệnh ghi (mọi nguồn). null = cho phép; "logic_need" | "logic_interlock" kèm <paramref name="why"/>. Chỉ xét lệnh BẬT
    /// (giá trị ≠ 0 trong khi đầu ra đang 0 / chưa biết) — TẮT luôn được phép.
    /// </summary>
    public string? Guard(PackMap f, double v, out string why)
    {
        why = "";
        if (v == 0) return null;
        var key = f.Child + "." + f.Field;
        lock (_gate)
        {
            var r = RuleOf(key);
            if (IsOn(key)) return null;   // đang bật: gửi lại giá trị bật / đổi mức không phải "bật mới"
            if (r != null && FailedCond(r) is { } fc)
            {
                why = $"{key}: chưa đủ điều kiện để bật — {fc}";
                R(key).GuardWhy = why; return "logic_need";
            }
            // liên động: đầu ra kia đang bật — HOẶC không rõ trạng thái (thiết bị RS485/TCP mất kết nối): không bật mạo hiểm
            if (_blk.TryGetValue(key, out var bs) && bs.FirstOrDefault(o => StateOf(o) != false) is { } other)
            {
                why = StateOf(other) == true ? $"{key}: liên động — {other} đang bật" : $"{key}: liên động — không rõ trạng thái {other} (mất kết nối thiết bị)";
                R(key).GuardWhy = why; return "logic_interlock";
            }
        }
        return null;
    }

    /// <summary>Người dùng (không phải chương trình) vừa đổi đầu ra: lúc đang chạy logic mất mạng thì chương trình nhường đầu ra đó tới khi có mạng lại.</summary>
    public void NoteManual(PackMap f)
    {
        var key = f.Child + "." + f.Field;
        lock (_gate)
            if (_rt.TryGetValue(key, out var r) && r.Active && !r.Manual)
            {
                r.Manual = true; r.Note = "đã thao tác tay — logic nhường tới khi có mạng lại";
                Log?.Invoke($"{key} đổi tay lúc đang chạy logic mất mạng → nhường");
            }
    }

    public void Test(int sec) { lock (_gate) _testUntil = sec <= 0 ? 0 : _mono() + Math.Min(sec, 3600) * 1000L; }

    /// <summary>Một nhịp (≈500 ms): hẹn giờ, tự tắt (mất điều kiện / chạy quá lâu), logic mất mạng. Trả các lần ghi cần làm.</summary>
    public List<LogicWrite> Tick()
    {
        var writes = new List<LogicWrite>();
        lock (_gate)
        {
            if (_prog.Do.Count == 0) { _downSince = -1; return writes; }
            var mono = _mono();
            var local = _now().ToUniversalTime().AddMinutes(_prog.TzMin);
            int minute = local.Hour * 60 + local.Minute;
            int wd = ((int)local.DayOfWeek + 6) % 7;   // 0 = thứ Hai
            var today = DateOnly.FromDateTime(local.DateTime);
            // mốc hẹn giờ đến lúc chưa: lặp theo thứ, hoặc 1 lần đúng ngày (giờ tắt < giờ bật: tắt hôm sau)
            bool Hit(LogicTimer t, bool on)
            {
                if (Hhmm(on ? t.On : t.Off) != minute) return false;
                if (t.Date == null) return t.Days == null || t.Days.Contains(wd + 1);
                if (!DateOnly.TryParseExact(t.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) return false;
                var next = !on && t.On != null && Hhmm(t.Off) < Hhmm(t.On);
                return today == (next ? d.AddDays(1) : d);
            }
            void Want(LogicRule r, double v, string why, bool retry = true)
            {
                var f = OutField(r.Out); if (f == null) return;
                var cur = ValueOf(r.Out).Value;
                if (cur is { } c && (c != 0) == (v != 0)) return;
                var rt = R(r.Out);
                // vừa thử ghi CÙNG giá trị: chờ PLC đọc lại rồi mới thử nữa (không dồn lệnh). Đổi ý (vd vừa bật, giờ mất điều kiện → tắt): ghi ngay.
                if (retry && mono - rt.LastTry < 5000 && rt.LastVal == v) return;
                rt.LastTry = mono; rt.LastVal = v;
                writes.Add(new LogicWrite(f, v, why));
            }

            // ---- hẹn giờ: đúng phút → bật / tắt (theo sự kiện)
            if (minute != _lastMin)
            {
                var first = _lastMin < 0; _lastMin = minute;
                if (!first)
                    foreach (var r in _prog.Do)
                        foreach (var t in r.Timer ?? new())
                        {
                            if (Hit(t, true)) { R(r.Out).LastTry = 0; Want(r, 1, $"hẹn giờ bật lúc {t.On}", retry: false); }
                            if (Hit(t, false)) { R(r.Out).LastTry = 0; Want(r, 0, $"hẹn giờ tắt lúc {t.Off}", retry: false); }
                        }
            }

            // ---- luôn chạy: mất điều kiện / chạy quá lâu → tự tắt
            foreach (var r in _prog.Do)
            {
                var rt = R(r.Out);
                var on = IsOn(r.Out);
                if (!on) { rt.OnSince = 0; continue; }
                if (rt.OnSince == 0) rt.OnSince = mono;
                if (r.NeedHold == true && FailedCond(r) is { } fc) { rt.GuardWhy = $"{r.Out}: mất điều kiện ({fc}) → tự tắt"; Want(r, 0, rt.GuardWhy); }
                else if (r.MaxOnSec is > 0 and var mx && mono - rt.OnSince >= mx * 1000L) { rt.GuardWhy = $"{r.Out}: chạy quá {mx} s → tự tắt"; Want(r, 0, rt.GuardWhy); }
            }

            // ---- mất mạng
            var test = _testUntil != 0 && mono < _testUntil;
            if (_testUntil != 0 && !test) { _testUntil = 0; Log?.Invoke("Hết thời gian thử mất mạng"); }
            var down = LinkUp() == false || test;
            if (!down)
            {
                if (_downSince >= 0 && _rt.Values.Any(x => x.Active)) Log?.Invoke("Có mạng lại — dừng logic khi mất mạng, đầu ra giữ trạng thái hiện tại");
                _downSince = -1;
                foreach (var x in _rt.Values) { x.Active = false; x.Manual = false; x.Note = ""; }
                return writes;
            }
            if (_downSince < 0) _downSince = mono;
            var downMs = mono - _downSince;
            foreach (var r in _prog.Do)
            {
                if (r.Mode == "hold") continue;
                var rt = R(r.Out);
                if (!rt.Active)
                {
                    if (!test && downMs < r.DelaySec * 1000L) { rt.Note = $"chờ {(r.DelaySec * 1000L - downMs + 999) / 1000} s"; continue; }
                    rt.Active = true; rt.Since = mono; rt.Thr = IsOn(r.Out);
                    Log?.Invoke($"Mất mạng {downMs / 1000} s — {r.Out} chạy theo logic ({r.Mode})");
                }
                if (rt.Manual) continue;
                bool want;
                switch (r.Mode)
                {
                    case "off": want = false; rt.Note = ""; break;
                    case "on": want = true; rt.Note = ""; break;
                    case "schedule":
                        int a = Hhmm(r.From), b = Hhmm(r.To);
                        want = a < b ? minute >= a && minute < b : minute >= a || minute < b;
                        rt.Note = $"{(want ? "trong" : "ngoài")} khung giờ ({local:HH:mm})";
                        break;
                    case "follow":
                        want = IsOn(r.Field!) != (r.Invert == true); rt.Note = $"{r.Field} = {ValueOf(r.Field!).Value}";
                        break;
                    case "threshold":
                        var (v, age) = ValueOf(r.Field!);
                        if (v == null || age > (r.MaxAgeSec ?? 30) * 1000L) { rt.Thr = false; want = false; rt.Note = "mất số liệu → tắt"; break; }
                        if (r.On < r.Off) { if (v <= r.On) rt.Thr = true; else if (v >= r.Off) rt.Thr = false; }
                        else { if (v >= r.On) rt.Thr = true; else if (v <= r.Off) rt.Thr = false; }
                        want = rt.Thr; rt.Note = $"giá trị {v}";
                        break;
                    case "cycle":
                        long per = (r.OnSec!.Value + r.OffSec!.Value) * 1000L, ph = (mono - rt.Since) % per;
                        want = ph < r.OnSec.Value * 1000L; rt.Note = want ? "đang chạy" : "đang nghỉ";
                        break;
                    default: continue;
                }
                Want(r, want ? 1 : 0, $"mất mạng: {r.Mode}");
            }
        }
        return writes;
    }

    /// <summary>GET /api/offline: chương trình + trạng thái chạy (cùng dạng với board, Ch → Out).</summary>
    public object Status()
    {
        lock (_gate)
        {
            var down = LinkUp() == false || (_testUntil != 0 && _mono() < _testUntil);
            return new
            {
                Down = down, DownSec = _downSince < 0 ? 0 : (_mono() - _downSince) / 1000, Expected = LinkUp() != null,
                TestSec = _testUntil == 0 ? 0 : Math.Max(0, (_testUntil - _mono()) / 1000), TimeOk = true,
                Ch = _prog.Do.Select(r =>
                {
                    var rt = R(r.Out);
                    return new { r.Out, r.Mode, rt.Active, rt.Manual, Value = IsOn(r.Out) ? 1 : 0, Note = rt.Note, GuardWhy = rt.GuardWhy };
                }).ToList(),
            };
        }
    }

    /// <summary>Phần "logic" trong bản tin config gửi cloud (server lưu, webapp xem bảng + đặt nút ⏰ cạnh nút điều khiển).</summary>
    public object CloudSummary(IConfigDescriber? d)
    {
        lock (_gate)
        {
            string Label(PackMap p)
            {
                var v = d?.Field(p.Child, p.Field);
                var dev = d?.DeviceTitle(p.Child) is { Length: > 0 } t ? t : p.Child;
                var l = string.IsNullOrWhiteSpace(v?.Label) ? p.Field : v!.Label;
                return dev + " · " + l + (string.IsNullOrWhiteSpace(v?.Unit) ? "" : $" ({v!.Unit})");
            }
            var outs = _cfg.Pack.Where(p => p.Access != PackAccess.Read).ToList();
            return new
            {
                rev = _prog.Rev, sha = Sha, tz = _prog.TzMin,
                @do = _prog.Do,
                names = new
                {
                    @out = outs.GroupBy(p => p.Child + "." + p.Field).ToDictionary(g => g.Key, g => Label(g.First())),
                    f = _cfg.Pack.Where(p => p.Access != PackAccess.Write).GroupBy(p => p.Child + "." + p.Field).ToDictionary(g => g.Key, g => Label(g.First())),
                },
                keys = outs.GroupBy(p => p.Child + "." + p.Field).ToDictionary(g => g.Key, g => g.First().Child + "." + g.First().WireKey),
            };
        }
    }
}
