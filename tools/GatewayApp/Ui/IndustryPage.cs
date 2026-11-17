using System.Drawing.Drawing2D;
using System.Text.Json;
namespace GatewayApp.Ui;

/// <summary>
/// Trang giao diện "giải pháp ngành" của gateway (chỉ đổi giao diện; ghép cặp, MQTT, thiết bị, cài đặt… dùng chung bản cơ bản).
/// Đọc cấu hình giao diện (cùng spec với webapp: chỉ số, ngưỡng, khối hiển thị) và vẽ bằng GDI+ từ số liệu của Pack
/// (TryValue "thiết bị.field"). Chạy --demo mà chưa có field của ngành này thì hiện số mẫu theo spec.
/// Một trang DÙNG CHUNG cho mọi giải pháp: giao diện là DỮ LIỆU (ui.json do server gửi trong kit lúc Enroll, lưu cache, xem SkinBoot.cs) — không cần build riêng.
/// Chỉ số suy diễn (expr) tính ngay trên gateway từ số cảm biến, không gửi qua server.
/// </summary>
sealed class IndustryPage : UserControl
{
    sealed class Metric
    {
        public string Id = "", Label = "", Unit = "", Agg = "last";
        public string? Expr;      // chỉ số suy diễn: công thức tính từ chỉ số/field khác
        public List<(string Key, double Mul)> Keys = new();
        public int? Dec; public double Min, Max = 100; public bool HasRange;
        public double? Lo, LoLo, Hi, HiHi;
        public Dictionary<string, string>? Map, Lv;
    }

    readonly IGatewayApp _app;
    readonly JsonElement _spec;
    readonly Dictionary<string, Metric> _m = new();
    readonly System.Windows.Forms.Timer _t = new() { Interval = 1000 };
    readonly bool _demoArg = Environment.GetCommandLineArgs().Contains("--demo");
    readonly DateTime _t0 = DateTime.Now;
    readonly Dictionary<string, List<double>> _hist = new();
    readonly Dictionary<string, List<(double A, double O)>> _trail = new();
    readonly List<(DateTime Ts, string Text, string Lv)> _log = new();
    readonly Dictionary<string, string> _prevLv = new();
    Dictionary<string, Dictionary<string, double>> _devs = new(StringComparer.OrdinalIgnoreCase);
    bool _demoShown;
    int _tab;                       // 0 = tổng quan; i = tab thứ i của spec
    /// <summary>
    /// GỘP: trang giải pháp nằm chung trang chính của gateway (một mục duy nhất, cùng thẻ thiết bị) — vẽ MỌI khối của mọi tab
    /// liền nhau, không có thanh tab; cao theo nội dung (trang chính cuộn), không tự cuộn.
    /// </summary>
    public bool Merged { get; set; }
    readonly List<(string Label, JsonElement Blocks)> _tabs = new();
    readonly List<(RectangleF R, int Idx)> _tabRects = new();
    DateTime _lastHist = DateTime.MinValue;

    public IndustryPage(IGatewayApp app, string specJson)
    {
        _app = app; _spec = JsonDocument.Parse(specJson).RootElement.Clone();
        BackColor = Theme.Bg; DoubleBuffered = true; ResizeRedraw = true; AutoScroll = true;
        foreach (var mj in _spec.GetProperty("metrics").EnumerateArray()) { var m = ParseMetric(mj); _m[m.Id] = m; }
        _tabs.Add(("Tổng quan", _spec.GetProperty("overview")));
        foreach (var t in _spec.GetProperty("tabs").EnumerateArray()) _tabs.Add((Str(t, "label"), t.GetProperty("blocks")));
        _t.Tick += (_, _) => { Tick(); Invalidate(); };
        _t.Start();
        Disposed += (_, _) => _t.Dispose();
        MouseDown += (_, e) => { foreach (var (r, i) in _tabRects) if (r.Contains(e.X, e.Y)) { _tab = i; AutoScrollPosition = new Point(0, 0); Invalidate(); } };
    }

    /* ------------------------------------------------------------ spec */
    static string Str(JsonElement e, string k, string d = "") => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? d : d;
    static double? Dbl(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    static Metric ParseMetric(JsonElement j)
    {
        var m = new Metric { Id = Str(j, "id"), Label = Str(j, "label"), Unit = Str(j, "unit"), Agg = Str(j, "agg", "last") };
        if (j.TryGetProperty("dec", out var d) && d.ValueKind == JsonValueKind.Number) m.Dec = d.GetInt32();
        if (j.TryGetProperty("min", out _) || j.TryGetProperty("max", out _)) { m.HasRange = true; m.Min = Dbl(j, "min") ?? 0; m.Max = Dbl(j, "max") ?? 100; }
        if (j.TryGetProperty("keys", out var ks))
            foreach (var k in ks.EnumerateArray())
                m.Keys.Add(k.ValueKind == JsonValueKind.Array ? (k[0].GetString()!.ToLowerInvariant(), k[1].GetDouble()) : (k.GetString()!.ToLowerInvariant(), 1));
        m.Expr = Str(j, "expr") is { Length: > 0 } ex ? ex : null;
        if (m.Keys.Count == 0) m.Keys.Add((m.Id.ToLowerInvariant(), 1));
        if (j.TryGetProperty("th", out var th)) { m.Lo = Dbl(th, "lo"); m.LoLo = Dbl(th, "loLo"); m.Hi = Dbl(th, "hi"); m.HiHi = Dbl(th, "hiHi"); }
        if (j.TryGetProperty("map", out var mp)) m.Map = mp.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "");
        if (j.TryGetProperty("lv", out var lv)) m.Lv = lv.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "");
        return m;
    }

    /* ------------------------------------------------------------ số liệu */
    Dictionary<string, Dictionary<string, double>> Read()
    {
        var d = new Dictionary<string, Dictionary<string, double>>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in _app.Config.Pack)
            if (_app.TryValue(UiMetaStore.Key(p.Child, p.Field), out var v))
            {
                if (!d.TryGetValue(p.Child, out var o)) d[p.Child] = o = new(StringComparer.OrdinalIgnoreCase);
                o[p.Field.ToLowerInvariant()] = v;
            }
        return d;
    }

    static double Gen(JsonElement g, double t)
    {
        switch (g.ValueKind)
        {
            case JsonValueKind.Number: return g.GetDouble();
            case JsonValueKind.Array:
                { var b = g[0].GetDouble(); var a = g[1].GetDouble(); var per = g.GetArrayLength() > 2 ? g[2].GetDouble() : 60; var ph = g.GetArrayLength() > 3 ? g[3].GetDouble() : 0;
                  return b + a * Math.Sin(2 * Math.PI * (t + ph) / per) + a * 0.05 * Math.Sin(t * 0.9 + ph); }
            case JsonValueKind.Object:
                if (g.TryGetProperty("sin", out var s)) { var per = s.GetArrayLength() > 2 ? s[2].GetDouble() : 60; var ph = s.GetArrayLength() > 3 ? s[3].GetDouble() : 0; return s[0].GetDouble() + s[1].GetDouble() * Math.Sin(2 * Math.PI * (t + ph) / per); }
                if (g.TryGetProperty("sq", out var q)) { var p = Dbl(g, "p") ?? 40; var duty = Dbl(g, "duty") ?? 0.7; var ph = Dbl(g, "ph") ?? 0; return ((t + ph) % p) / p < duty ? q[1].GetDouble() : q[0].GetDouble(); }
                if (g.TryGetProperty("cnt", out var c)) return (Dbl(g, "start") ?? 0) + c.GetDouble() * t;
                return 0;
            default: return 0;
        }
    }

    Dictionary<string, Dictionary<string, double>> DemoFrame(double t)
    {
        var d = new Dictionary<string, Dictionary<string, double>>(StringComparer.OrdinalIgnoreCase);
        if (!_spec.TryGetProperty("demo", out var demo)) return d;
        foreach (var dv in demo.GetProperty("devices").EnumerateObject())
        {
            var o = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in dv.Value.GetProperty("f").EnumerateObject()) o[f.Name.ToLowerInvariant()] = Gen(f.Value, t);
            d[dv.Name] = o;
        }
        return d;
    }

    void Tick()
    {
        var d = Read();
        _demoShown = false;
        if (_demoArg && (d.Count == 0 || d.Keys.All(k => k is "tank1" or "pump1" or "env1"))) {   // --demo: bộ mẫu bồn/bơm của gateway không thuộc ngành này → dùng số mẫu của ngành
            _demoShown = true; d = DemoFrame(1000 + (DateTime.Now - _t0).TotalSeconds); }
        _devs = d;
        var now = DateTime.Now;
        // vệt đường đi (bản đồ)
        foreach (var (id, o) in _devs)
            if (o.TryGetValue("lat", out var la) && o.TryGetValue("lon", out var lo))
            {
                if (!_trail.TryGetValue(id, out var tr)) _trail[id] = tr = new();
                if (tr.Count == 0 || tr[^1].A != la || tr[^1].O != lo) { tr.Add((la, lo)); if (tr.Count > 60) tr.RemoveAt(0); }
            }
        if ((now - _lastHist).TotalSeconds >= 2)
        {
            _lastHist = now;
            foreach (var m in _m.Values) { var v = Val(m.Id); if (v == null) continue; if (!_hist.TryGetValue(m.Id, out var h)) _hist[m.Id] = h = new(); h.Add(v.Value); if (h.Count > 90) h.RemoveAt(0); }
            // cảnh báo: ghi lại khi đổi mức
            foreach (var m in _m.Values)
            {
                if (m.Lv == null && !HasTh(m)) continue;
                var v = Val(m.Id); if (v == null) continue;
                var lv = LevelOf(m, v); _prevLv.TryGetValue(m.Id, out var was); was ??= "ok";
                var cur = string.IsNullOrEmpty(lv) ? "ok" : lv;
                if (cur != was && (cur is "warn" or "bad" || was is "warn" or "bad")) { _log.Insert(0, (now, $"{m.Label}: {Text(m, v)} {m.Unit}".Trim(), cur)); if (_log.Count > 30) _log.RemoveAt(_log.Count - 1); }
                _prevLv[m.Id] = cur;
            }
        }
    }

    static bool HasTh(Metric m) => m.Lo != null || m.LoLo != null || m.Hi != null || m.HiHi != null;

    int _depth;   // chống công thức tham chiếu vòng
    double? Calc(Metric m, Func<Metric, double?> getMetric, Func<string, double?> getRaw)
    {
        if (_depth > 6) return null;
        _depth++;
        try
        {
            return Expr.Eval(m.Expr!, name =>
            {
                var k = name.ToLowerInvariant();
                var id = _m.Keys.FirstOrDefault(x => string.Equals(x, name, StringComparison.OrdinalIgnoreCase));
                if (id != null && id != m.Id) return getMetric(_m[id]);
                var dot = k.IndexOf('.');
                if (dot > 0) return _devs.FirstOrDefault(d => string.Equals(d.Key, k[..dot], StringComparison.OrdinalIgnoreCase)).Value is { } dv && dv.TryGetValue(k[(dot + 1)..], out var x) ? x : null;
                return getRaw(k);
            });
        }
        finally { _depth--; }
    }

    double? Own(Dictionary<string, double> r, Metric m)
    {
        if (m.Expr != null) return Calc(m, x => Own(r, x), k => r.TryGetValue(k, out var v) ? v : null);
        foreach (var (k, mul) in m.Keys) if (r.TryGetValue(k, out var v)) return v * mul;
        return null;
    }

    double? Val(string id)
    {
        if (!_m.TryGetValue(id, out var m)) return null;
        if (m.Expr != null)
            return Calc(m, x => Val(x.Id), k => { double? last = null; foreach (var r in _devs.Values) if (r.TryGetValue(k, out var v)) last = v; return last; });
        var xs = new List<double>();
        foreach (var r in _devs.Values) { var v = Own(r, m); if (v != null) xs.Add(v.Value); }
        if (xs.Count == 0) return null;
        return m.Agg switch { "sum" => xs.Sum(), "avg" => xs.Average(), "max" => xs.Max(), "min" => xs.Min(), "count" => xs.Count(x => x > 0), _ => xs[^1] };
    }

    // "ok" | "warn" | "bad" | "off" | ""
    string LevelOf(Metric m, double? v)
    {
        if (v == null) return "";
        if (m.Lv != null) return m.Lv.TryGetValue(((long)Math.Round(v.Value)).ToString(), out var l) ? l : "";
        if (!HasTh(m)) return "";
        if ((m.HiHi != null && v >= m.HiHi) || (m.LoLo != null && v <= m.LoLo)) return "bad";
        if ((m.Hi != null && v >= m.Hi) || (m.Lo != null && v <= m.Lo)) return "warn";
        return "ok";
    }

    string Text(Metric m, double? v)
    {
        if (v == null) return "—";
        if (m.Map != null) return m.Map.TryGetValue(((long)Math.Round(v.Value)).ToString(), out var s) ? s : v.Value.ToString("0");
        if (m.Dec != null) return v.Value.ToString("F" + m.Dec);
        return Theme.Num(v.Value);
    }

    Color Lc(string lv) => lv switch { "ok" => Theme.Green, "warn" => Theme.Yellow, "bad" => Theme.Red, "off" => Theme.Muted, _ => Theme.Accent };
    Metric M(string id) => _m.TryGetValue(id, out var m) ? m : new Metric { Id = id, Label = id };
    string TitleOf(string id)
    {
        try { var dm = _app.Meta.Device(id); if (dm != null && !string.IsNullOrWhiteSpace(dm.Title)) return dm.Title; } catch { /* */ }
        if (_spec.TryGetProperty("demo", out var demo) && demo.GetProperty("devices").TryGetProperty(id, out var d) && d.TryGetProperty("title", out var t)) return t.GetString() ?? id;
        return id;
    }

    /* ------------------------------------------------------------ vẽ */
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics; Theme.Quality(g);
        g.TranslateTransform(AutoScrollPosition.X, AutoScrollPosition.Y);
        var pad = 20f; var w = Math.Max(300, ClientSize.Width - pad * 2 - (VerticalScroll.Visible ? SystemInformation.VerticalScrollBarWidth : 0));
        float y = pad;
        // tiêu đề + chip trạng thái
        using (var tb = new SolidBrush(Theme.Text)) g.DrawString(Str(_spec, "heading", Str(_spec, "title")), Theme.Big, tb, pad, y);
        var act = Active();
        var st = _devs.Count == 0 ? ("▲ Chưa có dữ liệu", Theme.Yellow) : _demoShown ? ("● Dữ liệu mẫu (--demo)", Theme.Teal) : act.Count > 0 ? ($"▲ {act.Count} cảnh báo", Theme.Yellow) : ("● Đang nhận dữ liệu", Theme.Green);
        using (var sb = new SolidBrush(st.Item2)) { var sz = g.MeasureString(st.Item1, Theme.Normal); g.DrawString(st.Item1, Theme.Normal, sb, pad + w - sz.Width, y + 10); }
        y += 46;
        if (!Merged)
        {
            // thanh tab
            _tabRects.Clear(); float tx = pad;
            for (var i = 0; i < _tabs.Count; i++)
            {
                var sz = g.MeasureString(_tabs[i].Label, Theme.Semi); var r = new RectangleF(tx, y, sz.Width + 24, 28);
                using (var path = Theme.Round(r, 14)) using (var br = new SolidBrush(i == _tab ? Theme.Accent : Theme.Panel)) using (var pen = new Pen(Theme.Border)) { g.FillPath(br, path); if (i != _tab) g.DrawPath(pen, path); }
                using (var tb = new SolidBrush(i == _tab ? Color.White : Theme.Muted)) g.DrawString(_tabs[i].Label, Theme.Semi, tb, r.X + 12, r.Y + 4);
                _tabRects.Add((new RectangleF(r.X + AutoScrollPosition.X * -1 - 0, r.Y + AutoScrollPosition.Y * -1, r.Width, r.Height), i)); tx += r.Width + 8;
            }
            y += 40;
        }
        y = MissingBanner(g, pad, y, w);
        // Gộp: mọi tab liền nhau (mỗi tab sau "Tổng quan" có tiêu đề nhóm); không gộp: chỉ tab đang chọn
        for (var ti = Merged ? 0 : _tab; ti < (Merged ? _tabs.Count : _tab + 1); ti++)
        {
            if (Merged && ti > 0)
            { using var hb = new SolidBrush(Theme.Text); g.DrawString(_tabs[ti].Label, Theme.Semi, hb, pad, y); y += 28; }
            foreach (var b in _tabs[ti].Blocks.EnumerateArray())
            {
                if (b.TryGetProperty("title", out var tt) && tt.ValueKind == JsonValueKind.String)
                { using var mb = new SolidBrush(Theme.Muted); g.DrawString((tt.GetString() ?? "").ToUpperInvariant(), Theme.Small, mb, pad, y); y += 20; }
                var h = Block(g, b, pad, y, w);
                y += h + 18;
            }
        }
        y += pad;
        var need = new Size(0, (int)y);
        if (Merged) { if (Height != need.Height) BeginInvoke(() => Height = need.Height); }   // cao theo nội dung, trang chính cuộn
        else if (AutoScrollMinSize.Height != need.Height) BeginInvoke(() => AutoScrollMinSize = need);
    }

    List<(Metric M, double? V, string Lv)> Active()
    {
        var l = new List<(Metric, double?, string)>();
        foreach (var m in _m.Values) { var v = Val(m.Id); var lv = LevelOf(m, v); if (lv is "warn" or "bad") l.Add((m, v, lv)); }
        return l;
    }

    float MissingBanner(Graphics g, float x, float y, float w)
    {
        if (_devs.Count == 0 || !_spec.TryGetProperty("required", out var req)) return y;
        var miss = new List<string>();
        foreach (var r in req.EnumerateArray())
        {
            var s = r.GetString() ?? "";
            if (s.StartsWith("key:")) { var k = s[4..].ToLowerInvariant(); if (!_devs.Values.Any(o => o.ContainsKey(k))) miss.Add(k); }
            else if (_m.TryGetValue(s, out var m) && Val(s) == null) miss.Add($"{m.Label} ({string.Join("/", m.Keys.Select(k => k.Key))})");
        }
        if (miss.Count == 0) return y;
        var text = "▲ Thiếu dữ liệu bắt buộc: " + string.Join(", ", miss) + "\n" + Str(_spec, "why");
        var rc = new RectangleF(x, y, w, 56);
        using var path = Theme.Round(rc, 8); using var br = new SolidBrush(Theme.Mix(Theme.Panel, Theme.Yellow, 0.14)); using var pen = new Pen(Theme.Yellow);
        g.FillPath(br, path); g.DrawPath(pen, path);
        using var tb = new SolidBrush(Theme.Text);
        g.DrawString(text, Theme.Small, tb, new RectangleF(x + 10, y + 6, w - 20, 48));
        return y + 66;
    }

    void Card(Graphics g, RectangleF r, Color? edge = null, string side = "")
    {
        using var path = Theme.Round(r, 10); using var br = new SolidBrush(Theme.Panel); using var pen = new Pen(Theme.Border);
        g.FillPath(br, path); g.DrawPath(pen, path);
        if (edge != null)
        {
            using var eb = new SolidBrush(edge.Value);
            if (side == "top") g.FillRectangle(eb, r.X + 8, r.Y, r.Width - 16, 4); else g.FillRectangle(eb, r.X, r.Y + 8, 4, r.Height - 16);
        }
    }

    float Block(Graphics g, JsonElement b, float x, float y, float w)
    {
        try
        {
            return Str(b, "type") switch
            {
                "kpis" => Kpis(g, b, x, y, w), "gauges" => Gauges(g, b, x, y, w), "ring" => Ring(g, b, x, y, w), "bars" => Bars(g, b, x, y, w),
                "state" => States(g, b, x, y, w), "tiles" => Tiles(g, b, x, y, w), "tank" or "tanks" => Tanks(g, b, x, y, w), "trend" => Trend(g, b, x, y, w),
                "alarms" => Alarms(g, x, y, w), "andon" => Andon(g, b, x, y, w), "line" => Line(g, b, x, y, w), "progress" => Progress(g, b, x, y, w),
                "plan" => Plan(g, b, x, y, w), "map" => Map(g, b, x, y, w), "elevator" => Elevator(g, b, x, y, w), "wind" => Wind(g, b, x, y, w),
                "pid" => Pid(g, b, x, y, w), "schedule" => Schedule(g, b, x, y, w), _ => 0f,
            };
        }
        catch (Exception) { return 0f; }
    }

    /// <summary>
    /// Thiết bị cho khối liệt kê THEO THIẾT BỊ: chỉ thiết bị có field GẮN vào khối (tên field trùng khoá chỉ số) — giống webapp (industry-engine idsFor).
    /// Thiết bị khác của gateway (vd. động cơ phụ) không chen vào danh sách, nó hiện thành widget riêng.
    /// </summary>
    List<string> DevIds(JsonElement b, params Metric?[] ms)
    {
        var use = ms.Where(m => m != null).Select(m => m!).ToList();
        return _devs.Keys.Where(k => (!b.TryGetProperty("only", out var o) || o.EnumerateArray().Any(z => z.GetString() == k))
            && (use.Count == 0 || use.Any(m => m.Expr != null ? Own(_devs[k], m) != null : m.Keys.Any(kk => _devs[k].ContainsKey(kk.Key))))).ToList();
    }

    IEnumerable<string> Items(JsonElement b, string k = "items") => b.TryGetProperty(k, out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().Select(v => v.GetString() ?? "") : Enumerable.Empty<string>();

    float Kpis(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); var cols = w >= 720 ? 4 : 2; var cw = (w - (cols - 1) * 10) / cols; var rows = (ids.Count + cols - 1) / cols;
        for (var i = 0; i < ids.Count; i++)
        {
            var m = M(ids[i]); var v = Val(ids[i]); var lv = LevelOf(m, v); var r = new RectangleF(x + (i % cols) * (cw + 10), y + (i / cols) * 74, cw, 64);
            Card(g, r, string.IsNullOrEmpty(lv) ? null : Lc(lv));
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            g.DrawString(m.Label, Theme.Small, mb, r.X + 14, r.Y + 8);
            var t = Text(m, v); g.DrawString(t, Theme.Big, tb, r.X + 12, r.Y + 24);
            if (m.Unit.Length > 0) g.DrawString(m.Unit, Theme.Small, mb, r.X + 14 + g.MeasureString(t, Theme.Big).Width, r.Y + 40);
        }
        return rows * 74 - 10;
    }

    void Arc(Graphics g, RectangleF r, Metric m, double? v, float stroke = 9)
    {
        var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
        var rr = new RectangleF(r.X + stroke, r.Y + stroke, r.Width - stroke * 2, r.Height - stroke * 2);
        using (var pen = new Pen(Theme.Border, stroke) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawArc(pen, rr, 144, 252);
        if (v != null) using (var pen = new Pen(Lc(string.IsNullOrEmpty(LevelOf(m, v)) ? "" : LevelOf(m, v)), stroke) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawArc(pen, rr, 144, Math.Max(2f, 252 * f));
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(Text(m, v), r.Width > 130 ? Theme.Huge : Theme.Big, tb, new RectangleF(r.X, r.Y + r.Height / 2 - 18, r.Width, 32), sf);
        g.DrawString(m.Unit, Theme.Small, mb, new RectangleF(r.X, r.Y + r.Height / 2 + 12, r.Width, 18), sf);
    }

    float Gauges(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); var n = Math.Max(1, ids.Count); var cw = (w - (n - 1) * 10) / n; var h = Math.Min(190f, cw);
        for (var i = 0; i < ids.Count; i++)
        {
            var r = new RectangleF(x + i * (cw + 10), y, cw, h + 26); Card(g, r);
            var m = M(ids[i]); Arc(g, new RectangleF(r.X + (cw - h) / 2 + 6, r.Y + 6, h - 12, h - 12), m, Val(ids[i]));
            using var mb = new SolidBrush(Theme.Muted); var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString(m.Label, Theme.Small, mb, new RectangleF(r.X, r.Bottom - 24, r.Width, 20), sf);
        }
        return h + 26;
    }

    float Ring(Graphics g, JsonElement b, float x, float y, float w)
    {
        var main = M(b.GetProperty("main").GetString()!); var subs = Items(b, "subs").ToList(); var h = 190f;
        var r = new RectangleF(x, y, w, h + 10); Card(g, r);
        Arc(g, new RectangleF(x + 14, y + 8, h - 6, h - 6), main, Val(main.Id), 12);
        using var mb = new SolidBrush(Theme.Muted); g.DrawString(main.Label, Theme.Semi, mb, x + 14 + (h - 6) / 2 - 24, y + h - 6);
        var cw = (w - h - 30) / Math.Max(1, subs.Count);
        for (var i = 0; i < subs.Count; i++)
        {
            var m = M(subs[i]); var rc = new RectangleF(x + h + 16 + i * cw, y + 30, cw - 6, Math.Min(cw - 6, 120));
            Arc(g, rc, m, Val(subs[i]), 7); g.DrawString(m.Label, Theme.Small, mb, rc.X + 4, rc.Bottom + 2);
        }
        return h + 10;
    }

    float Bars(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); var h = ids.Count * 30 + 16; Card(g, new RectangleF(x, y, w, h));
        for (var i = 0; i < ids.Count; i++)
        {
            var m = M(ids[i]); var v = Val(ids[i]); var ry = y + 12 + i * 30; var lv = LevelOf(m, v);
            var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text); using var trk = new SolidBrush(Theme.Border); using var fill = new SolidBrush(Lc(lv));
            g.DrawString(m.Label, Theme.Small, mb, x + 14, ry + 2);
            var bx = x + w * 0.26f; var bw = w * 0.5f; g.FillRectangle(trk, bx, ry + 6, bw, 9); g.FillRectangle(fill, bx, ry + 6, bw * f, 9);
            g.DrawString($"{Text(m, v)} {m.Unit}".Trim(), Theme.Normal, tb, bx + bw + 12, ry);
        }
        return h;
    }

    float States(Graphics g, JsonElement b, float x, float y, float w)
    {
        float cx = x, cy = y; const float h = 30;
        foreach (var id in Items(b))
        {
            var m = M(id); var v = Val(id); var lv = m.Lv != null ? LevelOf(m, v) : (v is > 0 ? "ok" : "off");
            var s = $"{m.Label}: {Text(m, v)}"; var sz = g.MeasureString(s, Theme.Small); var cw = sz.Width + 34;
            if (cx + cw > x + w) { cx = x; cy += h + 6; }
            var r = new RectangleF(cx, cy, cw, h); using var path = Theme.Round(r, 15); using var br = new SolidBrush(Theme.Panel); using var pen = new Pen(Theme.Border);
            g.FillPath(br, path); g.DrawPath(pen, path);
            using var dot = new SolidBrush(Lc(lv)); g.FillEllipse(dot, r.X + 10, r.Y + 10, 10, 10);
            using var tb = new SolidBrush(Theme.Text); g.DrawString(s, Theme.Small, tb, r.X + 26, r.Y + 7);
            cx += cw + 8;
        }
        return cy + h - y;
    }

    float Tiles(Graphics g, JsonElement b, float x, float y, float w)
    {
        var main = M(b.GetProperty("main").GetString()!); var subs = Items(b, "subs").Select(M).ToList();
        var ids = DevIds(b, subs.Prepend(main).ToArray());
        if (ids.Count == 0) return 0;
        var cols = w >= 760 ? 3 : 2; var cw = (w - (cols - 1) * 10) / cols; const float h = 118;
        for (var i = 0; i < ids.Count; i++)
        {
            var r = new RectangleF(x + (i % cols) * (cw + 10), y + (i / cols) * (h + 10), cw, h); var o = _devs[ids[i]];
            var v = Own(o, main); var lv = LevelOf(main, v); Card(g, r, string.IsNullOrEmpty(lv) ? null : Lc(lv), "top");
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            g.DrawString(TitleOf(ids[i]), Theme.Semi, tb, r.X + 12, r.Y + 10);
            var t = Text(main, v); g.DrawString(t, Theme.Big, tb, r.X + 10, r.Y + 32);
            g.DrawString(main.Unit, Theme.Small, mb, r.X + 14 + g.MeasureString(t, Theme.Big).Width, r.Y + 50);
            g.DrawString(main.Label, Theme.Small, mb, r.X + 12, r.Y + 68);
            var line = string.Join("  ", subs.Select(s => $"{s.Label} {Text(s, Own(o, s))}{(s.Unit.Length > 0 ? " " + s.Unit : "")}"));
            g.DrawString(line, Theme.Small, mb, new RectangleF(r.X + 12, r.Y + 88, r.Width - 20, 28));
        }
        return ((ids.Count + cols - 1) / cols) * (h + 10) - 10;
    }

    void TankAt(Graphics g, RectangleF r, Metric m, double? v, string label)
    {
        var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
        var lv = LevelOf(m, v);
        var body = new RectangleF(r.X + r.Width * 0.18f, r.Y, r.Width * 0.64f, r.Height - 22);
        using (var path = Theme.Round(body, 8)) using (var br = new SolidBrush(Theme.Panel2)) using (var pen = new Pen(Theme.Border, 2)) { g.FillPath(br, path); g.SetClip(path); using var fb = new SolidBrush(Color.FromArgb(215, Lc(lv))); g.FillRectangle(fb, body.X, body.Bottom - body.Height * f, body.Width, body.Height * f + 1); g.ResetClip(); g.DrawPath(pen, path); }
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted); var sf = new StringFormat { Alignment = StringAlignment.Center };
        g.DrawString($"{Text(m, v)} {m.Unit}".Trim(), Theme.Semi, tb, new RectangleF(body.X - 10, body.Y + body.Height / 2 - 10, body.Width + 20, 20), sf);
        g.DrawString(label, Theme.Small, mb, new RectangleF(r.X, r.Bottom - 18, r.Width, 18), sf);
    }

    float Tanks(Graphics g, JsonElement b, float x, float y, float w)
    {
        var perDev = Str(b, "type") == "tanks"; const float h = 150;
        var list = new List<(Metric M, double? V, string L)>();
        if (perDev) { var m = M(b.GetProperty("main").GetString()!); foreach (var id in DevIds(b, m)) list.Add((m, Own(_devs[id], m), TitleOf(id))); }
        else foreach (var id in Items(b)) list.Add((M(id), Val(id), M(id).Label));
        var cw = Math.Min(130f, w / Math.Max(1, list.Count)); var total = cw * list.Count; var sx = x + (w - total) / 2;
        Card(g, new RectangleF(x, y, w, h + 20));
        for (var i = 0; i < list.Count; i++) TankAt(g, new RectangleF(sx + i * cw + 4, y + 10, cw - 8, h), list[i].M, list[i].V, list[i].L);
        return h + 20;
    }

    float Trend(Graphics g, JsonElement b, float x, float y, float w)
    {
        var id = Str(b, "metric"); var m = M(id); const float h = 96; Card(g, new RectangleF(x, y, w, h));
        using var tb = new SolidBrush(Theme.Text); using var ab = new SolidBrush(Theme.Accent); using var mb = new SolidBrush(Theme.Muted);
        g.DrawString(Str(b, "title", m.Label), Theme.Semi, tb, x + 12, y + 8);
        var cur = $"{Text(m, Val(id))} {m.Unit}".Trim(); g.DrawString(cur, Theme.Semi, ab, x + w - g.MeasureString(cur, Theme.Semi).Width - 12, y + 8);
        if (_hist.TryGetValue(id, out var hs) && hs.Count > 1)
        {
            var lo = hs.Min(); var hi = hs.Max(); var span = hi - lo == 0 ? 1 : hi - lo; var px = x + 12; var pw = w - 24;
            var pts = hs.Select((v, i) => new PointF(px + pw * i / (90f - 1), y + h - 14 - (float)((v - lo) / span) * (h - 50))).ToArray();
            var shift = pw - pw * (hs.Count - 1) / (90f - 1); for (var i = 0; i < pts.Length; i++) pts[i].X += shift;
            using var pen = new Pen(Theme.Accent, 2); g.DrawLines(pen, pts);
            g.DrawString($"min {Theme.Num(lo)}   max {Theme.Num(hi)}", Theme.Small, mb, x + 12, y + h - 18);
        }
        else g.DrawString("Chờ dữ liệu…", Theme.Small, mb, x + 12, y + 40);
        return h;
    }

    float Alarms(Graphics g, float x, float y, float w)
    {
        var act = Active(); var rows = Math.Max(1, act.Count);
        Card(g, new RectangleF(x, y, w, rows * 28 + 14));
        if (act.Count == 0) { using var b = new SolidBrush(Theme.Green); g.DrawString("● Mọi chỉ số trong giới hạn an toàn.", Theme.Normal, b, x + 14, y + 10); }
        for (var i = 0; i < act.Count; i++)
        {
            using var dot = new SolidBrush(Lc(act[i].Lv)); using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
            g.FillEllipse(dot, x + 14, y + 14 + i * 28, 10, 10);
            g.DrawString($"{act[i].M.Label}  {Text(act[i].M, act[i].V)} {act[i].M.Unit}".Trim(), Theme.Normal, tb, x + 32, y + 9 + i * 28);
            var s = act[i].Lv == "bad" ? "Nguy hiểm" : "Cảnh báo"; g.DrawString(s, Theme.Small, mb, x + w - g.MeasureString(s, Theme.Small).Width - 14, y + 11 + i * 28);
        }
        return rows * 28 + 14;
    }

    float Andon(Graphics g, JsonElement b, float x, float y, float w)
    {
        var st = M(Str(b, "state")); var vm = b.TryGetProperty("value", out var vv) ? M(vv.GetString()!) : null; var ids = DevIds(b, st, vm);
        var cols = w >= 760 ? 3 : 2; var cw = (w - (cols - 1) * 10) / cols; const float h = 96; var blink = DateTime.Now.Second % 2 == 0;
        for (var i = 0; i < ids.Count; i++)
        {
            var o = _devs[ids[i]]; var v = Own(o, st); var lv = LevelOf(st, v); var col = lv == "" ? Theme.Muted : Lc(lv); if (lv == "bad" && blink) col = Theme.Mix(col, Color.Black, 0.3);
            var r = new RectangleF(x + (i % cols) * (cw + 10), y + (i / cols) * (h + 10), cw, h);
            using var path = Theme.Round(r, 10); using var br = new SolidBrush(col); g.FillPath(br, path);
            using var wb = new SolidBrush(Color.White); var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString(TitleOf(ids[i]), Theme.Semi, wb, new RectangleF(r.X, r.Y + 8, r.Width, 22), sf);
            g.DrawString(Text(st, v), Theme.Normal, wb, new RectangleF(r.X, r.Y + 30, r.Width, 22), sf);
            if (vm != null) g.DrawString($"{Text(vm, Own(o, vm))} {vm.Unit}".Trim(), Theme.Big, wb, new RectangleF(r.X, r.Y + 50, r.Width, 40), sf);
        }
        return ((ids.Count + cols - 1) / cols) * (h + 10) - 10;
    }

    float Line(Graphics g, JsonElement b, float x, float y, float w)
    {
        var st = M(Str(b, "state")); var sub = b.TryGetProperty("sub", out var s) ? M(s.GetString()!) : null; var ids = DevIds(b, st, sub); if (ids.Count == 0) return 0;
        var gap = 22f; var cw = (w - gap * (ids.Count - 1)) / ids.Count; const float h = 76;
        for (var i = 0; i < ids.Count; i++)
        {
            var o = _devs[ids[i]]; var v = Own(o, st); var lv = LevelOf(st, v); var r = new RectangleF(x + i * (cw + gap), y, cw, h);
            Card(g, r, lv == "" ? Theme.Muted : Lc(lv), "top");
            using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted); var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString(TitleOf(ids[i]), Theme.Small, tb, new RectangleF(r.X, r.Y + 10, r.Width, 18), sf); g.DrawString(Text(st, v), Theme.Semi, tb, new RectangleF(r.X, r.Y + 28, r.Width, 22), sf);
            if (sub != null) g.DrawString($"{Text(sub, Own(o, sub))} {sub.Unit}".Trim(), Theme.Small, mb, new RectangleF(r.X, r.Y + 52, r.Width, 18), sf);
            if (i > 0) using (var pen = new Pen(lv == "ok" ? Theme.Green : Theme.Border, 3)) g.DrawLine(pen, r.X - gap + 2, y + h / 2, r.X - 2, y + h / 2);
        }
        return h;
    }

    float Progress(Graphics g, JsonElement b, float x, float y, float w)
    {
        var items = b.GetProperty("items").EnumerateArray().ToList(); var h = items.Count * 50 + 14; Card(g, new RectangleF(x, y, w, h));
        for (var i = 0; i < items.Count; i++)
        {
            var it = items[i]; var a = M(Str(it, "actual")); var v = Val(a.Id); var tid = Str(it, "target");
            double? t = _m.ContainsKey(tid) ? Val(tid) : double.TryParse(tid, out var td) ? td : null;
            var f = v != null && t is > 0 ? (float)Math.Min(1.5, v.Value / t.Value) : 0f; var ry = y + 10 + i * 50;
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text); using var trk = new SolidBrush(Theme.Border); using var fill = new SolidBrush(f >= 1 ? Theme.Green : f >= 0.6 ? Theme.Accent : Theme.Yellow);
            g.DrawString(Str(it, "label", a.Label), Theme.Small, mb, x + 14, ry);
            var s = $"{Text(a, v)}{(t != null ? " / " + Theme.Num(t.Value) : "")} {a.Unit}".Trim(); g.DrawString(s, Theme.Semi, tb, x + w - g.MeasureString(s, Theme.Semi).Width - 14, ry - 2);
            var bw = w - 28; g.FillRectangle(trk, x + 14, ry + 24, bw, 12); g.FillRectangle(fill, x + 14, ry + 24, bw * Math.Min(1f, f), 12);
            using var mk = new Pen(Theme.Text, 2); g.DrawLine(mk, x + 14 + bw, ry + 20, x + 14 + bw, ry + 40);
        }
        return h;
    }

    float Plan(Graphics g, JsonElement b, float x, float y, float w)
    {
        var W = Dbl(b, "w") ?? 100; var H = Dbl(b, "h") ?? 60; var s = (float)(w / W); var h = (float)(H * s); var main = M(Str(b, "main"));
        using (var path = Theme.Round(new RectangleF(x, y, w, h), 8)) using (var br = new SolidBrush(Theme.Panel)) using (var pen = new Pen(Theme.Border)) { g.FillPath(br, path); g.DrawPath(pen, path); }
        foreach (var r in b.GetProperty("rooms").EnumerateArray())
        {
            var rc = new RectangleF(x + (float)(Dbl(r, "x") ?? 0) * s, y + (float)(Dbl(r, "y") ?? 0) * s, (float)(Dbl(r, "w") ?? 0) * s, (float)(Dbl(r, "h") ?? 0) * s);
            using var fb = new SolidBrush(Theme.Panel2); using var pen = new Pen(Theme.Border); using var mb = new SolidBrush(Theme.Muted);
            g.FillRectangle(fb, rc); g.DrawRectangle(pen, rc.X, rc.Y, rc.Width, rc.Height); g.DrawString(Str(r, "label"), Theme.Small, mb, rc.X + 6, rc.Y + 4);
        }
        foreach (var mk in b.GetProperty("markers").EnumerateArray())
        {
            var id = Str(mk, "dev"); var cx = x + (float)(Dbl(mk, "x") ?? 0) * s; var cy = y + (float)(Dbl(mk, "y") ?? 0) * s;
            double? v = _devs.TryGetValue(id, out var o) ? Own(o, main) : null; var lv = LevelOf(main, v); using var c = new SolidBrush(v == null ? Theme.Muted : Lc(lv));
            g.FillEllipse(c, cx - 15, cy - 15, 30, 30); using var wb = new SolidBrush(Color.White); var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(Text(main, v), Theme.Small, wb, new RectangleF(cx - 18, cy - 9, 36, 18), sf);
            using var tb = new SolidBrush(Theme.Text); g.DrawString(Str(mk, "label", TitleOf(id)), Theme.Small, tb, new RectangleF(cx - 50, cy + 16, 100, 18), sf);
        }
        return h;
    }

    float Map(Graphics g, JsonElement b, float x, float y, float w)
    {
        const float h = 250; Card(g, new RectangleF(x, y, w, h));
        var ids = _trail.Keys.Where(k => _trail[k].Count > 0).ToList();
        using var mb = new SolidBrush(Theme.Muted);
        if (ids.Count == 0) { g.DrawString("Chưa có vị trí (field lat, lon).", Theme.Normal, mb, x + 14, y + 14); return h; }
        var pts = ids.SelectMany(i => _trail[i]).ToList();
        double a0 = pts.Min(p => p.A), a1 = pts.Max(p => p.A), o0 = pts.Min(p => p.O), o1 = pts.Max(p => p.O);
        var pa = Math.Max(0.002, (a1 - a0) * 0.18); var po = Math.Max(0.002, (o1 - o0) * 0.18); a0 -= pa; a1 += pa; o0 -= po; o1 += po;
        var k = Math.Cos((a0 + a1) / 2 * Math.PI / 180); var sx = (o1 - o0) * k; var sy = a1 - a0; var sc = Math.Min((w - 20) / sx, (h - 20) / sy);
        var ox = x + 10 + (w - 20 - sx * sc) / 2; var oy = y + 10 + (h - 20 - sy * sc) / 2;
        PointF P(double a, double o) => new((float)(ox + (o - o0) * k * sc), (float)(oy + (a1 - a) * sc));
        using (var gp = new Pen(Theme.Border, 1)) for (var i = 1; i < 6; i++) { g.DrawLine(gp, x + w / 6 * i, y, x + w / 6 * i, y + h); g.DrawLine(gp, x, y + h / 6 * i, x + w, y + h / 6 * i); }
        var st = b.TryGetProperty("state", out var sj) ? M(sj.GetString()!) : null;
        foreach (var id in ids)
        {
            var tr = _trail[id]; var o = _devs.TryGetValue(id, out var d) ? d : null; var lv = st != null && o != null ? LevelOf(st, Own(o, st)) : "ok"; var col = Lc(lv == "" ? "off" : lv);
            if (tr.Count > 1) using (var pen = new Pen(Color.FromArgb(150, col), 2)) g.DrawLines(pen, tr.Select(p => P(p.A, p.O)).ToArray());
            var c = P(tr[^1].A, tr[^1].O); using var cb = new SolidBrush(col); g.FillEllipse(cb, c.X - 6, c.Y - 6, 12, 12);
            using var tb = new SolidBrush(Theme.Text); var sf = new StringFormat { Alignment = StringAlignment.Center }; g.DrawString(TitleOf(id), Theme.Small, tb, new RectangleF(c.X - 70, c.Y - 24, 140, 16), sf);
        }
        return h;
    }

    float Elevator(Graphics g, JsonElement b, float x, float y, float w)
    {
        var N = (int)(Dbl(b, "floors") ?? 10); var fm = Str(b, "floor", "floor").ToLowerInvariant(); var ids = DevIds(b, new Metric { Id = fm, Keys = { (fm, 1) } }); const float sh = 200; float h = sh + 74;
        Card(g, new RectangleF(x, y, w, h)); using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
        for (var i = 0; i < N; i++) g.DrawString((i + 1).ToString(), Theme.Small, mb, x + 12, y + 12 + (sh - 16) * (1 - (float)i / (N - 1)) - 6);
        var cw = Math.Min(130f, (w - 60) / Math.Max(1, ids.Count));
        for (var i = 0; i < ids.Count; i++)
        {
            var o = _devs[ids[i]]; var f = o.TryGetValue(fm, out var fv) ? fv : 1; var door = o.TryGetValue(Str(b, "door", "door").ToLowerInvariant(), out var dv) && dv > 0;
            var shaft = new RectangleF(x + 50 + i * cw, y + 12, cw - 24, sh); using (var pen = new Pen(Theme.Border, 2)) g.DrawRectangle(pen, shaft.X, shaft.Y, shaft.Width, shaft.Height);
            var pos = (float)(Math.Clamp(f, 1, N) - 1) / (N - 1); using var cab = new SolidBrush(door ? Theme.Green : Theme.Accent);
            g.FillRectangle(cab, shaft.X + 6, shaft.Bottom - 30 - (shaft.Height - 30) * pos, shaft.Width - 12, 28);
            var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString(TitleOf(ids[i]), Theme.Small, tb, new RectangleF(shaft.X - 10, shaft.Bottom + 6, shaft.Width + 20, 16), sf);
            g.DrawString($"Tầng {Math.Round(f)} · {(door ? "cửa mở" : "cửa đóng")}", Theme.Small, mb, new RectangleF(shaft.X - 12, shaft.Bottom + 24, shaft.Width + 24, 16), sf);
        }
        return h;
    }

    float Wind(Graphics g, JsonElement b, float x, float y, float w)
    {
        const float h = 150; Card(g, new RectangleF(x, y, w, h)); var d = Val(Str(b, "dir")); var sm = b.TryGetProperty("speed", out var sp) ? M(sp.GetString()!) : null;
        var c = new PointF(x + 90, y + h / 2); using (var pen = new Pen(Theme.Border, 2)) g.DrawEllipse(pen, c.X - 55, c.Y - 55, 110, 110);
        using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text); using var ab = new SolidBrush(Theme.Accent);
        g.DrawString("B", Theme.Small, mb, c.X - 5, c.Y - 72); g.DrawString("N", Theme.Small, mb, c.X - 5, c.Y + 56); g.DrawString("Đ", Theme.Small, mb, c.X + 58, c.Y - 8); g.DrawString("T", Theme.Small, mb, c.X - 70, c.Y - 8);
        var st = g.Save(); g.TranslateTransform(c.X, c.Y); g.RotateTransform((float)(d ?? 0)); g.FillPolygon(ab, new[] { new PointF(0, -42), new PointF(9, 14), new PointF(0, 6), new PointF(-9, 14) }); g.Restore(st);
        if (sm != null) { var v = Val(sm.Id); g.DrawString($"{Text(sm, v)} {sm.Unit}".Trim(), Theme.Huge, tb, x + 190, y + 40); }
        g.DrawString($"Hướng {(d == null ? "—" : Math.Round(d.Value) + "°")}", Theme.Normal, mb, x + 190, y + 86);
        return h;
    }

    float Pid(Graphics g, JsonElement b, float x, float y, float w)
    {
        var W = Dbl(b, "w") ?? 120; var H = Dbl(b, "h") ?? 70; var s = (float)(w / W); var h = (float)(H * s); Card(g, new RectangleF(x, y, w, h));
        PointF P(double px, double py) => new(x + (float)px * s, y + (float)py * s);
        foreach (var p in b.GetProperty("pipes").EnumerateArray())
        {
            var pts = p.GetProperty("pts").EnumerateArray().Select(q => P(q[0].GetDouble(), q[1].GetDouble())).ToArray(); var on = !p.TryGetProperty("on", out var oj) || (Val(oj.GetString()!) ?? 0) > 0;
            using var pen = new Pen(Theme.Border, 6 * s / 2.6f) { LineJoin = LineJoin.Round }; g.DrawLines(pen, pts);
            if (on) using (var fp = new Pen(Theme.Accent, 3) { DashStyle = DashStyle.Dash, DashOffset = (float)((DateTime.Now - _t0).TotalSeconds * 3) % 6 }) g.DrawLines(fp, pts);
        }
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted); var sf = new StringFormat { Alignment = StringAlignment.Center };
        foreach (var n in b.GetProperty("nodes").EnumerateArray())
        {
            var kind = Str(n, "kind"); var m = n.TryGetProperty("metric", out var mj) ? M(mj.GetString()!) : null; var v = m != null ? Val(m.Id) : null; var lv = m != null ? LevelOf(m, v) : ""; var col = Lc(lv);
            var cx = (float)(Dbl(n, "x") ?? 0); var cy = (float)(Dbl(n, "y") ?? 0); var label = Str(n, "label");
            if (kind is "tank" or "vessel")
            {
                var nw = (float)(Dbl(n, "w") ?? 16) * s; var nh = (float)(Dbl(n, "h") ?? 20) * s; var r = new RectangleF(P(cx, 0).X - nw / 2, P(0, cy).Y, nw, nh);
                var f = kind == "tank" && m != null && v != null ? (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1) : 0.55f;
                using var br = new SolidBrush(Theme.Panel2); using var pen = new Pen(col, 2); g.FillRectangle(br, r); using var fb = new SolidBrush(Color.FromArgb(190, col)); g.FillRectangle(fb, r.X + 2, r.Bottom - r.Height * f, r.Width - 4, r.Height * f - 1); g.DrawRectangle(pen, r.X, r.Y, r.Width, r.Height);
                if (m != null) g.DrawString($"{Text(m, v)} {m.Unit}".Trim(), Theme.Small, tb, new RectangleF(r.X - 10, r.Y + r.Height / 2 - 8, r.Width + 20, 16), sf);
                g.DrawString(label, Theme.Small, mb, new RectangleF(r.X - 20, r.Bottom + 2, r.Width + 40, 16), sf);
            }
            else if (kind == "pump") { var c = P(cx, cy); var run = (v ?? 0) > 0; using var br = new SolidBrush(Theme.Panel2); using var pen = new Pen(run ? Theme.Green : Theme.Muted, 2); g.FillEllipse(br, c.X - 13, c.Y - 13, 26, 26); g.DrawEllipse(pen, c.X - 13, c.Y - 13, 26, 26); using var ib = new SolidBrush(Theme.Accent); g.FillPolygon(ib, new[] { new PointF(c.X, c.Y - 8), new PointF(c.X + 7, c.Y + 5), new PointF(c.X - 7, c.Y + 5) }); g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 40, c.Y + 15, 80, 16), sf); }
            else if (kind == "valve") { var c = P(cx, cy); var open = (v ?? 0) > 0; using var vb = new SolidBrush(open ? Theme.Green : Theme.Red); g.FillPolygon(vb, new[] { new PointF(c.X - 9, c.Y - 8), new PointF(c.X + 9, c.Y + 8), new PointF(c.X + 9, c.Y - 8), new PointF(c.X - 9, c.Y + 8) }); g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 40, c.Y + 12, 80, 16), sf); }
            else { var c = P(cx, cy); var r = new RectangleF(c.X - 30, c.Y - 11, 60, 22); using var br = new SolidBrush(Theme.Panel2); using var pen = new Pen(col, 1.5f); g.FillRectangle(br, r); g.DrawRectangle(pen, r.X, r.Y, r.Width, r.Height); if (m != null) g.DrawString($"{Text(m, v)} {m.Unit}".Trim(), Theme.Small, tb, r, new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }); g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 40, c.Y + 12, 80, 16), sf); }
        }
        return h;
    }

    static int Hm(string t) { var p = t.Split(':'); return int.Parse(p[0]) * 60 + (p.Length > 1 ? int.Parse(p[1]) : 0); }

    float Schedule(Graphics g, JsonElement b, float x, float y, float w)
    {
        var rows = b.GetProperty("rows").EnumerateArray().ToList(); var now = DateTime.Now; var dow = ((int)now.DayOfWeek + 6) % 7 + 1; var min = now.Hour * 60 + now.Minute;
        var h = rows.Count * 44 + 40; Card(g, new RectangleF(x, y, w, h)); using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text); using var trk = new SolidBrush(Theme.Border); using var fill = new SolidBrush(Theme.Accent);
        var sx = x + w * 0.24f; var sw = w * 0.56f; var dw = sw / 7;
        for (var d = 0; d < 7; d++) g.DrawString(new[] { "T2", "T3", "T4", "T5", "T6", "T7", "CN" }[d], Theme.Small, d + 1 == dow ? tb : mb, sx + d * dw + dw / 2 - 8, y + 8);
        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i]; var ry = y + 30 + i * 44; var a = Hm(Str(r, "on")); var z = Hm(Str(r, "off")); var days = r.TryGetProperty("days", out var dj) ? dj.EnumerateArray().Select(q => q.GetInt32()).ToList() : new List<int> { 1, 2, 3, 4, 5, 6, 7 };
            g.DrawString(Str(r, "label"), Theme.Small, tb, x + 14, ry + 2); g.DrawString($"{Str(r, "on")}–{Str(r, "off")}", Theme.Small, mb, x + 14, ry + 18);
            var inWin = days.Contains(dow) && (a <= z ? min >= a && min < z : min >= a || min < z);
            for (var d = 0; d < 7; d++)
            {
                var c = new RectangleF(sx + d * dw + 2, ry, dw - 4, 26); g.FillRectangle(trk, c);
                if (days.Contains(d + 1)) { var len = z > a ? z - a : 1440 - a + z; g.FillRectangle(fill, c.X + c.Width * a / 1440f, c.Y, Math.Max(2, c.Width * len / 1440f), c.Height); }
                if (d + 1 == dow) { using var mk = new Pen(Theme.Red, 2); g.DrawLine(mk, c.X + c.Width * min / 1440f, c.Y, c.X + c.Width * min / 1440f, c.Bottom); }
            }
            using var sb = new SolidBrush(inWin ? Theme.Green : Theme.Muted); g.DrawString(inWin ? "● BẬT" : "○ Tắt", Theme.Small, sb, sx + sw + 12, ry + 6);
        }
        return h;
    }
}
