using System.Drawing.Drawing2D;
using System.Text.Json;
namespace GatewayApp.Ui;

/// <summary>
/// Trang giao diện "giải pháp ngành" của gateway (chỉ đổi giao diện; ghép cặp, MQTT, thiết bị, cài đặt… dùng chung bản cơ bản).
/// Đọc cấu hình giao diện (cùng spec với webapp: chỉ số, ngưỡng, khối hiển thị) và vẽ bằng GDI+ từ số liệu của Pack
/// (TryValue "thiết bị.field").
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
        public string Icon = "chart";   // icon đại lượng đo (cùng luật với webapp: IconData.ForMetric)
    }

    readonly IGatewayApp _app;
    readonly JsonElement _spec;
    readonly Dictionary<string, Metric> _m = new();
    readonly System.Windows.Forms.Timer _t = new() { Interval = 1000 };
    readonly DateTime _t0 = DateTime.Now;
    readonly Dictionary<string, List<double>> _hist = new();
    readonly Dictionary<string, List<(double A, double O)>> _trail = new();
    readonly List<(DateTime Ts, string Text, string Lv)> _log = new();
    readonly Dictionary<string, string> _prevLv = new();
    Dictionary<string, Dictionary<string, double>> _devs = new(StringComparer.OrdinalIgnoreCase);
    int _tab;                       // 0 = tổng quan; i = tab thứ i của spec
    /// <summary>
    /// GỘP: trang giải pháp nằm chung trang chính của gateway (một mục duy nhất, cùng thẻ thiết bị) — vẽ MỌI khối của mọi tab
    /// liền nhau, không có thanh tab; cao theo nội dung (trang chính cuộn), không tự cuộn.
    /// </summary>
    public bool Merged { get; set; }
    readonly List<(string Label, string Icon, JsonElement Blocks)> _tabs = new();
    readonly List<(RectangleF R, int Idx)> _tabRects = new();
    DateTime _lastHist = DateTime.MinValue;

    public IndustryPage(IGatewayApp app, string specJson)
    {
        _app = app; _spec = JsonDocument.Parse(specJson).RootElement.Clone();
        BackColor = Theme.Bg; DoubleBuffered = true; ResizeRedraw = true; AutoScroll = true; Skin.DarkScroll(this);
        foreach (var mj in _spec.GetProperty("metrics").EnumerateArray()) { var m = ParseMetric(mj); _m[m.Id] = m; }
        _tabs.Add(("Tổng quan", Str(_spec, "icon", "grid"), _spec.GetProperty("overview")));
        foreach (var t in _spec.GetProperty("tabs").EnumerateArray()) _tabs.Add((Str(t, "label"), Str(t, "icon", "chart"), t.GetProperty("blocks")));
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
        m.Icon = j.TryGetProperty("icon", out var ic) && ic.ValueKind == JsonValueKind.String && Icons.Has(ic.GetString()) ? ic.GetString()!
            : IconData.ForMetric(m.Id, m.Label, m.Unit, m.Keys.Select(k => k.Key), m.Map?.Values);
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

    void Tick()
    {
        var d = Read();
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
        if (m.Dec != null) return Group(v.Value.ToString("F" + m.Dec));
        return Group(Theme.Num(v.Value));
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
        var pad = Merged ? 2f : 20f; var w = Math.Max(300, ClientSize.Width - pad * 2 - (VerticalScroll.Visible ? SystemInformation.VerticalScrollBarWidth : 0));
        float y = Merged ? 4f : pad;
        var act = Active();
        var st = _devs.Count == 0 ? ("Chưa có dữ liệu", Theme.Yellow) : act.Count > 0 ? ($"{act.Count} cảnh báo", Theme.Yellow) : ("Đang nhận dữ liệu", Theme.Green);
        if (!Merged)
        {
            // tiêu đề có icon giải pháp (gộp vào trang chính thì tiêu đề nằm ở thanh trên của cửa sổ)
            Icons.Badge(g, Str(_spec, "icon", "chart"), new RectangleF(pad, y + 2, 38, 38), Theme.Accent, 10);
            using (var tb = new SolidBrush(Theme.Text)) g.DrawString(Str(_spec, "heading", Str(_spec, "title")), Theme.Big, tb, pad + 48, y);
        }
        // chip trạng thái: chấm màu + chữ, số thiết bị đang gửi dữ liệu
        {
            var txt = st.Item1 + (_devs.Count > 0 ? $"  ·  {_devs.Count} thiết bị" : "");
            var sz = g.MeasureString(txt, Theme.Small);
            var r = Merged ? new RectangleF(pad, y, sz.Width + 34, 26) : new RectangleF(pad + w - sz.Width - 34, y + 8, sz.Width + 34, 26);
            using (var path = Theme.Round(r, 13)) using (var br = new SolidBrush(Color.FromArgb(34, st.Item2))) using (var pen = new Pen(Color.FromArgb(110, st.Item2))) { g.FillPath(br, path); g.DrawPath(pen, path); }
            var pulse = (float)(0.5 + 0.5 * Math.Sin((DateTime.Now - _t0).TotalSeconds * 3));
            using (var halo = new SolidBrush(Color.FromArgb((int)(70 * pulse), st.Item2))) g.FillEllipse(halo, r.X + 7, r.Y + 6, 14, 14);
            using (var dot = new SolidBrush(st.Item2)) g.FillEllipse(dot, r.X + 10, r.Y + 9, 8, 8);
            using var tb = new SolidBrush(Theme.Text); g.DrawString(txt, Theme.Small, tb, r.X + 24, r.Y + 5);
        }
        y += Merged ? 38 : 50;
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
        // Gộp: mọi tab liền nhau (mỗi tab sau "Tổng quan" có tiêu đề nhóm); không gộp: chỉ tab đang chọn.
        // Khi gộp, khối trùng hệt khối đã vẽ (vd. "Cảnh báo" có ở cả tổng quan lẫn tab An toàn) chỉ vẽ một lần.
        var seen = new HashSet<string>();
        for (var ti = Merged ? 0 : _tab; ti < (Merged ? _tabs.Count : _tab + 1); ti++)
        {
            var blocks = _tabs[ti].Blocks.EnumerateArray().Where(b => !Merged || seen.Add(Str(b, "type") switch { "alarms" => "alarms", "trend" => "trend:" + Str(b, "metric"), _ => b.GetRawText() })).ToList();
            if (blocks.Count == 0) continue;
            if (Merged && ti > 0) y = Section(g, _tabs[ti].Label, _tabs[ti].Icon, pad, y, w);
            foreach (var b in blocks)
            {
                var title = Str(b, "title");
                if (title.Length > 0 && Str(b, "type") != "trend")
                { using var mb = new SolidBrush(Theme.Muted); g.DrawString(title.ToUpperInvariant(), Theme.Small, mb, pad + 2, y); y += 20; }
                var h = Block(g, b, pad, y, w);
                if (h > 0) y += h + 16; else if (title.Length > 0 && Str(b, "type") != "trend") y -= 20;
            }
        }
        y += pad;
        var need = new Size(0, (int)y);
        if (Merged) { if (Height != need.Height) BeginInvoke(() => Height = need.Height); }   // cao theo nội dung, trang chính cuộn
        else if (AutoScrollMinSize.Height != need.Height) BeginInvoke(() => AutoScrollMinSize = need);
    }

    /// <summary>Tiêu đề nhóm (một tab của giải pháp khi gộp vào trang chính): icon + chữ + vạch mảnh.</summary>
    float Section(Graphics g, string label, string icon, float x, float y, float w)
    {
        y += 6;
        Icons.Draw(g, icon, new RectangleF(x, y + 1, 20, 20), Theme.Accent);
        using (var hb = new SolidBrush(Theme.Text)) g.DrawString(label, Theme.Title, hb, x + 28, y);
        var tw = g.MeasureString(label, Theme.Title).Width;
        using (var pen = new Pen(Color.FromArgb(150, Theme.Border))) g.DrawLine(pen, x + 36 + tw, y + 12, x + w, y + 12);
        return y + 34;
    }

    /// <summary>Số đẹp cho chỉ số: ≥ 10 000 có dấu cách hàng nghìn (27 650).</summary>
    static string Group(string t) => t.Length > 4 && double.TryParse(t, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) && Math.Abs(d) >= 10000 && !t.Contains('.')
        ? d.ToString("#,0", System.Globalization.CultureInfo.InvariantCulture).Replace(",", " ") : t;

    List<(Metric M, double? V, string Lv)> Active()
    {
        var l = new List<(Metric, double?, string)>();
        foreach (var m in _m.Values) { var v = Val(m.Id); var lv = LevelOf(m, v); if (lv is "warn" or "bad") l.Add((m, v, lv)); }
        return l;
    }

    /// <summary>Kiểm thử: các chỉ số được khối nào đó trong giao diện dùng mà CHƯA có số (để chắc dữ liệu thử lấp đủ mọi widget).</summary>
    internal List<string> UnfilledMetrics()
    {
        Tick();
        var used = new HashSet<string>();
        void Walk(JsonElement e)
        {
            switch (e.ValueKind)
            {
                case JsonValueKind.String: if (e.GetString() is { } v && _m.ContainsKey(v)) used.Add(v); break;
                case JsonValueKind.Array: foreach (var x in e.EnumerateArray()) Walk(x); break;
                case JsonValueKind.Object: foreach (var p in e.EnumerateObject()) Walk(p.Value); break;
            }
        }
        foreach (var (_, _, blocks) in _tabs) Walk(blocks);
        var miss = used.Where(id => Val(id) == null).OrderBy(x => x).ToList();
        // ô theo TỪNG thiết bị: mỗi thiết bị liệt kê phải có số cho chỉ số chính + phụ
        foreach (var (_, _, blocks) in _tabs)
            foreach (var b in blocks.EnumerateArray())
            {
                var ids = new List<string>();
                switch (Str(b, "type"))
                {
                    case "tiles": ids.Add(Str(b, "main")); ids.AddRange(Items(b, "subs")); break;
                    case "andon": ids.Add(Str(b, "state")); if (b.TryGetProperty("value", out var v)) ids.Add(v.GetString() ?? ""); break;
                    case "line": ids.Add(Str(b, "state")); if (b.TryGetProperty("sub", out var sb)) ids.Add(sb.GetString() ?? ""); break;
                    default: continue;
                }
                var ms = ids.Where(i => _m.ContainsKey(i)).Select(i => _m[i]).ToArray();
                foreach (var dev in DevIds(b, ms))
                    foreach (var m in ms) if (Own(_devs[dev], m) == null) miss.Add($"{dev}.{m.Id}");
                if (Str(b, "type") is "plan") { }
            }
        // bản đồ / mặt bằng: thiết bị đặt trên sơ đồ phải có dữ liệu
        foreach (var (_, _, blocks) in _tabs)
            foreach (var b in blocks.EnumerateArray())
            {
                if (Str(b, "type") == "plan" && b.TryGetProperty("markers", out var mk) && _m.TryGetValue(Str(b, "main"), out var mm))
                    foreach (var k in mk.EnumerateArray()) { var d = Str(k, "dev"); if (!_devs.TryGetValue(d, out var o) || Own(o, mm) == null) miss.Add($"marker:{d}"); }
                if (Str(b, "type") == "map" && !_trail.Values.Any(t => t.Count > 0)) miss.Add("map:lat/lon");
            }
        return miss.Distinct().ToList();
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
        var text = "▲ Chưa nhận được đủ dữ liệu để theo dõi an toàn: " + string.Join(", ", miss) + "\n" + Str(_spec, "why") + " Hãy thêm thiết bị đo tương ứng ở mục Thiết bị và đặt đúng tên field.";
        var bh = Math.Max(56f, g.MeasureString(text, Theme.Small, (int)(w - 20)).Height + 14);   // cao theo nội dung, không bị cắt chữ
        var rc = new RectangleF(x, y, w, bh);
        using var path = Theme.Round(rc, 8); using var br = new SolidBrush(Theme.Mix(Theme.Panel, Theme.Yellow, 0.14)); using var pen = new Pen(Theme.Yellow);
        g.FillPath(br, path); g.DrawPath(pen, path);
        using var tb = new SolidBrush(Theme.Text);
        g.DrawString(text, Theme.Small, tb, new RectangleF(x + 10, y + 7, w - 20, bh - 10));
        return y + bh + 10;
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

    static readonly StringFormat NoWrap = new() { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
    static readonly StringFormat Center = new() { Alignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };

    /// <summary>Màu nhấn của một chỉ số: vàng/đỏ khi vượt ngưỡng, xám khi tắt, còn lại màu chủ đề (không tô xanh lá tràn lan).</summary>
    Color Tone(string lv) => lv is "warn" or "bad" or "off" ? Lc(lv) : Theme.Accent;

    /// <summary>Icon nhỏ + nhãn, căn giữa trong khung rộng cw.</summary>
    void IconLabel(Graphics g, string icon, string label, float x, float y, float cw, Color ic)
    {
        var lw = Math.Min(g.MeasureString(label, Theme.Small).Width, cw - 30); var total = 20 + lw; var sx = x + (cw - total) / 2;
        Icons.Draw(g, icon, new RectangleF(sx, y + 1, 15, 15), ic);
        using var mb = new SolidBrush(Theme.Muted); g.DrawString(label, Theme.Small, mb, new RectangleF(sx + 20, y, lw + 4, 18), NoWrap);
    }

    float Kpis(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); if (ids.Count == 0) return 0;
        var cols = Math.Min(w >= 720 ? 4 : 2, ids.Count); var cw = (w - (cols - 1) * 12) / cols; var rows = (ids.Count + cols - 1) / cols; const float h = 78;
        for (var i = 0; i < ids.Count; i++)
        {
            var m = M(ids[i]); var v = Val(ids[i]); var lv = LevelOf(m, v); var col = Tone(lv);
            var r = new RectangleF(x + (i % cols) * (cw + 12), y + (i / cols) * (h + 12), cw, h);
            Card(g, r, lv is "warn" or "bad" ? col : null);
            Icons.Badge(g, m.Icon, new RectangleF(r.Right - 46, r.Y + 13, 34, 34), col, 10);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            g.DrawString(m.Label, Theme.Small, mb, new RectangleF(r.X + 14, r.Y + 11, r.Width - 68, 18), NoWrap);
            var t = Text(m, v); g.DrawString(t, Theme.Big, tb, r.X + 10, r.Y + 31);
            if (m.Unit.Length > 0) g.DrawString(m.Unit, Theme.Small, mb, r.X + 8 + g.MeasureString(t, Theme.Big).Width, r.Y + 47);
        }
        return rows * (h + 12) - 12;
    }

    void Arc(Graphics g, RectangleF r, Metric m, double? v, float stroke = 9, bool ends = false)
    {
        var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
        var rr = new RectangleF(r.X + stroke, r.Y + stroke, r.Width - stroke * 2, r.Height - stroke * 2);
        using (var pen = new Pen(Theme.Mix(Theme.Panel, Theme.Border, 0.9), stroke) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawArc(pen, rr, 144, 252);
        var lv = LevelOf(m, v);
        // vạch ngưỡng trên cung (vàng = cảnh báo, đỏ = nguy hiểm)
        void Tick(double? t, Color c)
        {
            if (t == null || m.Max <= m.Min) return; var a = (144 + 252 * Math.Clamp((t.Value - m.Min) / (m.Max - m.Min), 0, 1)) * Math.PI / 180;
            float cx = rr.X + rr.Width / 2, cy = rr.Y + rr.Height / 2, ro = rr.Width / 2 + stroke * 0.75f, ri = rr.Width / 2 - stroke * 0.75f;
            using var p = new Pen(c, 2); g.DrawLine(p, cx + ri * (float)Math.Cos(a), cy + ri * (float)Math.Sin(a), cx + ro * (float)Math.Cos(a), cy + ro * (float)Math.Sin(a));
        }
        if (v != null)
        {
            var col = lv == "" ? Theme.Accent : Lc(lv);
            using var pen = new Pen(col, stroke) { StartCap = LineCap.Round, EndCap = LineCap.Round }; g.DrawArc(pen, rr, 144, Math.Max(2f, 252 * f));
        }
        Tick(m.Hi, Theme.Yellow); Tick(m.Lo, Theme.Yellow); Tick(m.HiHi, Theme.Red); Tick(m.LoLo, Theme.Red);
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        var big = r.Width > 130 ? Theme.Huge : r.Width > 80 ? Theme.Big : Theme.Semi;
        g.DrawString(Text(m, v), big, tb, new RectangleF(r.X - 10, r.Y + r.Height / 2 - 20, r.Width + 20, 36), sf);
        g.DrawString(m.Unit, Theme.Small, mb, new RectangleF(r.X, r.Y + r.Height / 2 + 12, r.Width, 18), sf);
        if (ends && m.HasRange)
        {
            g.DrawString(Theme.Num(m.Min), Theme.Small, mb, new RectangleF(r.X, r.Bottom - 22, r.Width / 2 - 10, 16), new StringFormat { Alignment = StringAlignment.Center });
            g.DrawString(Theme.Num(m.Max), Theme.Small, mb, new RectangleF(r.X + r.Width / 2 + 10, r.Bottom - 22, r.Width / 2 - 10, 16), new StringFormat { Alignment = StringAlignment.Center });
        }
    }

    float Gauges(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); if (ids.Count == 0) return 0;
        var n = ids.Count; var cw = (w - (n - 1) * 12) / n; var gs = Math.Min(156f, cw - 30); var h = gs + 40;
        for (var i = 0; i < n; i++)
        {
            var r = new RectangleF(x + i * (cw + 12), y, cw, h); Card(g, r);
            var m = M(ids[i]); var v = Val(ids[i]);
            Arc(g, new RectangleF(r.X + (cw - gs) / 2, r.Y + 10, gs, gs), m, v, gs > 120 ? 10 : 8, true);
            IconLabel(g, m.Icon, m.Label, r.X, r.Bottom - 30, cw, Tone(LevelOf(m, v)));
        }
        return h;
    }

    float Ring(Graphics g, JsonElement b, float x, float y, float w)
    {
        var main = M(b.GetProperty("main").GetString()!); var subs = Items(b, "subs").ToList(); const float ms = 158; const float h = ms + 46;
        Card(g, new RectangleF(x, y, w, h));
        Arc(g, new RectangleF(x + 22, y + 12, ms, ms), main, Val(main.Id), 13);
        IconLabel(g, main.Icon, main.Label, x + 22, y + ms + 16, ms, Theme.Accent);
        var sx = x + ms + 56;
        using (var sep = new Pen(Theme.Border)) g.DrawLine(sep, sx - 18, y + 22, sx - 18, y + h - 22);
        var n = Math.Max(1, subs.Count); var cw = (x + w - 16 - sx) / n; var ss = Math.Min(cw - 26, 124f);
        for (var i = 0; i < subs.Count; i++)
        {
            var m = M(subs[i]); var v = Val(subs[i]);
            var rc = new RectangleF(sx + i * cw + (cw - ss) / 2, y + 12 + (ms - ss) / 2, ss, ss);
            Arc(g, rc, m, v, 8);
            IconLabel(g, m.Icon, m.Label, sx + i * cw, y + ms + 16, cw, Tone(LevelOf(m, v)));
        }
        return h;
    }

    float Bars(Graphics g, JsonElement b, float x, float y, float w)
    {
        var ids = Items(b).ToList(); if (ids.Count == 0) return 0; const float rh = 36; var h = ids.Count * rh + 16;
        Card(g, new RectangleF(x, y, w, h));
        var lw = ids.Max(id => g.MeasureString(M(id).Label, Theme.Small).Width);
        var bx = x + Math.Max(w * 0.2f, 46 + lw + 12); var bw = x + w - 120 - bx;
        for (var i = 0; i < ids.Count; i++)
        {
            var m = M(ids[i]); var v = Val(ids[i]); var ry = y + 8 + i * rh; var lv = LevelOf(m, v); var col = lv == "" ? Theme.Accent : Lc(lv);
            var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            Icons.Draw(g, m.Icon, new RectangleF(x + 16, ry + 9, 18, 18), Tone(lv));
            g.DrawString(m.Label, Theme.Small, mb, new RectangleF(x + 42, ry + 10, bx - x - 50, 18), NoWrap);
            var track = new RectangleF(bx, ry + 13, bw, 10);
            using (var tp = Theme.Round(track, 5)) using (var tbr = new SolidBrush(Theme.Mix(Theme.Panel, Theme.Border, 0.8))) g.FillPath(tbr, tp);
            if (f > 0.005) using (var fp = Theme.Round(new RectangleF(bx, ry + 13, Math.Max(10, bw * f), 10), 5)) using (var fb = new SolidBrush(col)) g.FillPath(fb, fp);
            void Mark(double? t, Color c) { if (t == null || m.Max <= m.Min) return; var tx = bx + bw * (float)Math.Clamp((t.Value - m.Min) / (m.Max - m.Min), 0, 1); using var p = new Pen(c, 2); g.DrawLine(p, tx, ry + 9, tx, ry + 27); }
            Mark(m.Hi, Theme.Yellow); Mark(m.Lo, Theme.Yellow); Mark(m.HiHi, Theme.Red); Mark(m.LoLo, Theme.Red);
            var s = $"{Text(m, v)} {m.Unit}".Trim(); g.DrawString(s, Theme.Semi, tb, x + w - 14 - g.MeasureString(s, Theme.Semi).Width, ry + 7);
        }
        return h;
    }

    float States(Graphics g, JsonElement b, float x, float y, float w)
    {
        float cx = x, cy = y; const float h = 34;
        foreach (var id in Items(b))
        {
            var m = M(id); var v = Val(id); var lv = m.Lv != null ? LevelOf(m, v) : (v is > 0 ? "ok" : "off"); var col = lv == "" ? Theme.Accent : Lc(lv);
            var lab = m.Label; var val = Text(m, v);
            var w1 = g.MeasureString(lab, Theme.Small).Width; var w2 = g.MeasureString(val, Theme.Semi).Width; var cw = 38 + w1 + w2 + 6;
            if (cx + cw > x + w && cx > x) { cx = x; cy += h + 8; }
            var r = new RectangleF(cx, cy, cw, h);
            using (var path = Theme.Round(r, h / 2))
            using (var br = new SolidBrush(lv == "off" ? Theme.Panel : Theme.Mix(Theme.Panel, col, 0.12)))
            using (var pen = new Pen(lv == "off" ? Theme.Border : Theme.Mix(Theme.Border, col, 0.45))) { g.FillPath(br, path); g.DrawPath(pen, path); }
            Icons.Draw(g, m.Icon, new RectangleF(r.X + 11, r.Y + 8, 18, 18), col);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(lv == "off" ? Theme.Muted : Theme.Text);
            g.DrawString(lab, Theme.Small, mb, r.X + 34, r.Y + 9); g.DrawString(val, Theme.Semi, tb, r.X + 34 + w1, r.Y + 7);
            cx += cw + 8;
        }
        return cy + h - y;
    }

    float Tiles(Graphics g, JsonElement b, float x, float y, float w)
    {
        var main = M(b.GetProperty("main").GetString()!); var subs = Items(b, "subs").Select(M).ToList();
        var ids = DevIds(b, subs.Prepend(main).ToArray());
        if (ids.Count == 0) return 0;
        var cols = w >= 760 ? 3 : 2; var cw = (w - (cols - 1) * 12) / cols; const float h = 124;
        for (var i = 0; i < ids.Count; i++)
        {
            var r = new RectangleF(x + (i % cols) * (cw + 12), y + (i / cols) * (h + 12), cw, h); var o = _devs[ids[i]];
            var v = Own(o, main); var lv = LevelOf(main, v); var col = Tone(lv);
            Card(g, r, lv is "warn" or "bad" ? col : null, "top");
            Icons.Badge(g, main.Icon, new RectangleF(r.Right - 44, r.Y + 12, 32, 32), col, 9);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            g.DrawString(TitleOf(ids[i]), Theme.Semi, tb, new RectangleF(r.X + 14, r.Y + 12, r.Width - 66, 20), NoWrap);
            var t = Text(main, v); g.DrawString(t, Theme.Big, tb, r.X + 10, r.Y + 32);
            var tw = g.MeasureString(t, Theme.Big).Width;
            g.DrawString($"{main.Unit}  {main.Label}".Trim(), Theme.Small, mb, r.X + 8 + tw, r.Y + 48);
            // chỉ số phụ: icon (nói lên đại lượng) + số, xếp ngang, xuống dòng khi hết chỗ
            float sx = r.X + 14, sy = r.Y + 82;
            foreach (var s in subs)
            {
                var sv = Own(o, s); var txt = $"{Text(s, sv)}{(s.Unit.Length > 0 ? " " + s.Unit : "")}"; var slv = LevelOf(s, sv);
                var sw = 20 + g.MeasureString(txt, Theme.Small).Width + 10;
                if (sx + sw > r.Right - 10 && sx > r.X + 14) { sx = r.X + 14; sy += 20; if (sy > r.Bottom - 16) break; }
                Icons.Draw(g, s.Icon, new RectangleF(sx, sy + 1, 15, 15), slv is "warn" or "bad" ? Lc(slv) : Theme.Muted);
                using var vb = new SolidBrush(slv is "warn" or "bad" ? Lc(slv) : Theme.Text); g.DrawString(txt, Theme.Small, vb, sx + 18, sy);
                sx += sw;
            }
        }
        return ((ids.Count + cols - 1) / cols) * (h + 12) - 12;
    }

    /// <summary>Bồn kính: chất lỏng màu chủ đề (vàng/đỏ khi vượt ngưỡng), mặt sóng, vạch chia, số ở giữa.</summary>
    void TankAt(Graphics g, RectangleF r, Metric m, double? v, string label)
    {
        var f = v == null ? 0f : (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1);
        var lv = LevelOf(m, v); var liquid = lv is "warn" or "bad" ? Lc(lv) : Theme.Accent;
        var bw = Math.Min(r.Width * 0.62f, 96); var body = new RectangleF(r.X + (r.Width - bw) / 2, r.Y, bw, r.Height - 24);
        using (var path = Theme.Round(body, 10))
        {
            using (var br = new SolidBrush(Theme.Panel2)) g.FillPath(br, path);
            if (f > 0.002)
            {
                var st = g.Save(); g.SetClip(path);
                var top = body.Bottom - body.Height * f; var ph = (float)((DateTime.Now - _t0).TotalSeconds * 2.2);
                using var wave = new GraphicsPath(); var pts = new List<PointF> { new(body.Left - 2, body.Bottom + 2) };
                for (var xx = body.Left - 2; xx <= body.Right + 2; xx += 3) pts.Add(new PointF(xx, top + (float)Math.Sin(xx / 9.0 + ph) * 2f));
                pts.Add(new PointF(body.Right + 2, body.Bottom + 2)); wave.AddPolygon(pts.ToArray());
                using (var lb = new LinearGradientBrush(new RectangleF(body.X, top - 3, body.Width, body.Bottom - top + 6), Color.FromArgb(225, liquid), Color.FromArgb(150, Theme.Mix(liquid, Color.Black, 0.45)), 90f)) g.FillPath(lb, wave);
                g.Restore(st);
            }
            using (var hl = new Pen(Color.FromArgb(40, 255, 255, 255), 3)) g.DrawLine(hl, body.X + 8, body.Y + 10, body.X + 8, body.Bottom - 10);
            using (var tk = new Pen(Color.FromArgb(90, Theme.Muted))) for (var i = 1; i < 4; i++) g.DrawLine(tk, body.Right - 12, body.Y + body.Height * i / 4, body.Right - 5, body.Y + body.Height * i / 4);
            using var pen = new Pen(lv is "warn" or "bad" ? Lc(lv) : Theme.Border, 2); g.DrawPath(pen, path);
        }
        using var tb = new SolidBrush(Color.White); using var sh = new SolidBrush(Color.FromArgb(120, 0, 0, 0)); using var mb = new SolidBrush(Theme.Muted);
        var txt = $"{Text(m, v)} {m.Unit}".Trim(); var tr = new RectangleF(body.X - 10, body.Y + body.Height / 2 - 10, body.Width + 20, 22);
        g.DrawString(txt, Theme.Semi, sh, new RectangleF(tr.X + 1, tr.Y + 1, tr.Width, tr.Height), Center); g.DrawString(txt, Theme.Semi, tb, tr, Center);
        g.DrawString(label, Theme.Small, mb, new RectangleF(r.X - 6, r.Bottom - 19, r.Width + 12, 18), Center);
    }

    float Tanks(Graphics g, JsonElement b, float x, float y, float w)
    {
        var perDev = Str(b, "type") == "tanks"; const float h = 170;
        var list = new List<(Metric M, double? V, string L)>();
        if (perDev) { var m = M(b.GetProperty("main").GetString()!); foreach (var id in DevIds(b, m)) list.Add((m, Own(_devs[id], m), TitleOf(id))); }
        else foreach (var id in Items(b)) list.Add((M(id), Val(id), M(id).Label));
        if (list.Count == 0) return 0;
        if (list.Count == 1 && w > 520)
        {
            // một bồn: bồn bên trái, bên phải là số lớn + trạng thái + ngưỡng (không để thẻ rộng trống trơn)
            var (m1, v1, l1) = list[0]; var lv = LevelOf(m1, v1);
            Card(g, new RectangleF(x, y, w, h + 24));
            TankAt(g, new RectangleF(x + 30, y + 14, 150, h), m1, v1, "");
            float tx = x + 220, ty = y + 26;
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
            Icons.Draw(g, m1.Icon, new RectangleF(tx, ty + 1, 18, 18), Theme.Accent); g.DrawString(l1, Theme.Title, tb, tx + 26, ty);
            var t = Text(m1, v1); g.DrawString(t, Theme.Huge, tb, tx - 4, ty + 28);
            g.DrawString(m1.Unit, Theme.Normal, mb, tx + g.MeasureString(t, Theme.Huge).Width - 8, ty + 50);
            var (stTxt, stCol) = lv switch { "bad" => ("Nguy hiểm", Theme.Red), "warn" => (v1 != null && m1.Lo != null && v1 <= m1.Lo ? "Mức thấp" : "Mức cao", Theme.Yellow), "" => ("—", Theme.Muted), _ => ("Bình thường", Theme.Green) };
            var pr = new RectangleF(tx, ty + 88, g.MeasureString(stTxt, Theme.Small).Width + 20, 22);
            using (var pp = Theme.Round(pr, 11)) using (var pb = new SolidBrush(Color.FromArgb(46, stCol))) g.FillPath(pb, pp);
            using (var sb = new SolidBrush(stCol)) g.DrawString(stTxt, Theme.Small, sb, pr.X + 10, pr.Y + 3);
            var th = new List<string>();
            if (m1.LoLo != null) th.Add($"rất thấp ≤ {Theme.Num(m1.LoLo.Value)}"); if (m1.Lo != null) th.Add($"thấp ≤ {Theme.Num(m1.Lo.Value)}");
            if (m1.Hi != null) th.Add($"cao ≥ {Theme.Num(m1.Hi.Value)}"); if (m1.HiHi != null) th.Add($"rất cao ≥ {Theme.Num(m1.HiHi.Value)}");
            if (th.Count > 0) g.DrawString("Ngưỡng: " + string.Join("  ·  ", th) + (m1.Unit.Length > 0 ? " " + m1.Unit : ""), Theme.Small, mb, tx, ty + 122);
            return h + 24;
        }
        var cw = Math.Min(150f, (w - 20) / list.Count); var total = cw * list.Count; var sx = x + (w - total) / 2;
        Card(g, new RectangleF(x, y, w, h + 24));
        for (var i = 0; i < list.Count; i++) TankAt(g, new RectangleF(sx + i * cw + 6, y + 14, cw - 12, h), list[i].M, list[i].V, list[i].L);
        return h + 24;
    }

    float Trend(Graphics g, JsonElement b, float x, float y, float w)
    {
        var id = Str(b, "metric"); var m = M(id); const float h = 138; Card(g, new RectangleF(x, y, w, h));
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
        var v = Val(id); var lv = LevelOf(m, v); var col = lv is "warn" or "bad" ? Lc(lv) : Theme.Accent;
        Icons.Badge(g, m.Icon, new RectangleF(x + 12, y + 10, 28, 28), Theme.Accent, 8);
        g.DrawString(Str(b, "title", m.Label), Theme.Semi, tb, x + 48, y + 14);
        var cur = $"{Text(m, v)} {m.Unit}".Trim();
        using (var cb = new SolidBrush(col)) g.DrawString(cur, Theme.Title, cb, x + w - g.MeasureString(cur, Theme.Title).Width - 12, y + 12);
        var plot = new RectangleF(x + 14, y + 48, w - 28, h - 48 - 22);
        if (_hist.TryGetValue(id, out var hs) && hs.Count > 1)
        {
            var lo = hs.Min(); var hi = hs.Max(); var pad = Math.Max((hi - lo) * 0.15, Math.Abs(hi) * 0.002 + 1e-6); lo -= pad; hi += pad;
            using (var grid = new Pen(Color.FromArgb(55, Theme.Border)) { DashStyle = DashStyle.Dot })
                for (var i = 0; i <= 2; i++) g.DrawLine(grid, plot.X, plot.Y + plot.Height * i / 2, plot.Right, plot.Y + plot.Height * i / 2);
            var slots = Math.Max(hs.Count, 30) - 1;
            var pts = hs.Select((q, i) => new PointF(plot.Right - plot.Width * (hs.Count - 1 - i) / slots, plot.Bottom - (float)((q - lo) / (hi - lo)) * plot.Height)).ToArray();
            using (var area = new GraphicsPath())
            {
                area.AddLines(pts); area.AddLine(pts[^1], new PointF(pts[^1].X, plot.Bottom)); area.AddLine(new PointF(pts[^1].X, plot.Bottom), new PointF(pts[0].X, plot.Bottom)); area.CloseFigure();
                using var ab = new LinearGradientBrush(new RectangleF(plot.X, plot.Y - 1, plot.Width, plot.Height + 2), Color.FromArgb(80, col), Color.FromArgb(0, col), 90f); g.FillPath(ab, area);
            }
            using (var pen = new Pen(col, 2) { LineJoin = LineJoin.Round }) g.DrawLines(pen, pts);
            using (var halo = new SolidBrush(Color.FromArgb(60, col))) g.FillEllipse(halo, pts[^1].X - 7, pts[^1].Y - 7, 14, 14);
            using (var dot = new SolidBrush(col)) g.FillEllipse(dot, pts[^1].X - 3.5f, pts[^1].Y - 3.5f, 7, 7);
            g.DrawString($"thấp {Theme.Num(hs.Min())}   cao {Theme.Num(hs.Max())}   ·   {hs.Count * 2 / 60.0:0.#} phút gần nhất", Theme.Small, mb, x + 14, y + h - 20);
        }
        else g.DrawString("Đang gom dữ liệu cho biểu đồ…", Theme.Small, mb, plot.X, plot.Y + plot.Height / 2 - 8);
        return h;
    }

    float Alarms(Graphics g, float x, float y, float w)
    {
        var act = Active(); var rows = Math.Max(1, act.Count); const float rh = 34; var h = rows * rh + 12;
        Card(g, new RectangleF(x, y, w, h), act.Count == 0 ? null : act.Any(a => a.Lv == "bad") ? Theme.Red : Theme.Yellow);
        if (act.Count == 0)
        {
            Icons.Draw(g, "check", new RectangleF(x + 16, y + 13, 20, 20), Theme.Green);
            using var b = new SolidBrush(Theme.Green); g.DrawString("Mọi chỉ số trong giới hạn an toàn", Theme.Normal, b, x + 44, y + 13);
            return h;
        }
        for (var i = 0; i < act.Count; i++)
        {
            var ry = y + 6 + i * rh; var col = Lc(act[i].Lv);
            Icons.Draw(g, act[i].Lv == "bad" ? "warn" : act[i].M.Icon, new RectangleF(x + 16, ry + 7, 20, 20), col);
            using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
            g.DrawString(act[i].M.Label, Theme.Normal, tb, x + 44, ry + 7);
            var lw = g.MeasureString(act[i].M.Label, Theme.Normal).Width;
            using (var vb = new SolidBrush(col)) g.DrawString($"{Text(act[i].M, act[i].V)} {act[i].M.Unit}".Trim(), Theme.Semi, vb, x + 48 + lw, ry + 7);
            var s = act[i].Lv == "bad" ? "Nguy hiểm" : "Cảnh báo"; var sw = g.MeasureString(s, Theme.Small).Width + 18;
            var pr = new RectangleF(x + w - sw - 14, ry + 6, sw, 22);
            using (var pp = Theme.Round(pr, 11)) using (var pb = new SolidBrush(Color.FromArgb(46, col))) g.FillPath(pb, pp);
            using (var sb = new SolidBrush(col)) g.DrawString(s, Theme.Small, sb, pr.X + 9, pr.Y + 3);
            if (i < act.Count - 1) using (var sep = new Pen(Color.FromArgb(90, Theme.Border))) g.DrawLine(sep, x + 44, ry + rh, x + w - 14, ry + rh);
        }
        return h;
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

    /// <summary>Tỉ lệ vẽ sơ đồ theo toạ độ spec: vừa bề ngang nhưng không cao quá maxH (sơ đồ rộng không phóng to quá cỡ), căn giữa.</summary>
    static (float S, float Ox, float H) Fit(double W, double H, float x, float w, float maxH)
    {
        var s = (float)Math.Min((w - 24) / W, maxH / H); var pw = (float)(W * s);
        return (s, x + (w - pw) / 2, (float)(H * s));
    }

    float Plan(Graphics g, JsonElement b, float x, float y, float w)
    {
        var W = Dbl(b, "w") ?? 100; var H = Dbl(b, "h") ?? 60; var (s, ox, ph) = Fit(W, H, x, w, 360); var h = ph + 20; var main = M(Str(b, "main"));
        Card(g, new RectangleF(x, y, w, h)); var oy = y + 10;
        foreach (var r in b.GetProperty("rooms").EnumerateArray())
        {
            var rc = new RectangleF(ox + (float)(Dbl(r, "x") ?? 0) * s, oy + (float)(Dbl(r, "y") ?? 0) * s, (float)(Dbl(r, "w") ?? 0) * s, (float)(Dbl(r, "h") ?? 0) * s);
            using var path = Theme.Round(rc, 6); using var fb = new SolidBrush(Theme.Panel2); using var pen = new Pen(Theme.Border); using var mb = new SolidBrush(Theme.Muted);
            g.FillPath(fb, path); g.DrawPath(pen, path); g.DrawString(Str(r, "label"), Theme.Small, mb, rc.X + 8, rc.Y + 6);
        }
        var blink = (float)(0.5 + 0.5 * Math.Sin((DateTime.Now - _t0).TotalSeconds * 4));
        foreach (var mk in b.GetProperty("markers").EnumerateArray())
        {
            var id = Str(mk, "dev"); var cx = ox + (float)(Dbl(mk, "x") ?? 0) * s; var cy = oy + (float)(Dbl(mk, "y") ?? 0) * s;
            double? v = _devs.TryGetValue(id, out var o) ? Own(o, main) : null; var lv = LevelOf(main, v); var col = v == null ? Theme.Muted : lv == "" ? Theme.Accent : Lc(lv);
            if (lv is "warn" or "bad") using (var halo = new SolidBrush(Color.FromArgb((int)(40 + 60 * blink), col))) g.FillEllipse(halo, cx - 26, cy - 26, 52, 52);
            using (var c = new SolidBrush(col)) g.FillEllipse(c, cx - 19, cy - 19, 38, 38);
            using (var ring = new Pen(Color.FromArgb(90, 255, 255, 255), 2)) g.DrawEllipse(ring, cx - 19, cy - 19, 38, 38);
            using var wb = new SolidBrush(Color.White); var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(Text(main, v), Theme.Semi, wb, new RectangleF(cx - 26, cy - 10, 52, 20), sf);
            using var tb = new SolidBrush(Theme.Text); g.DrawString(Str(mk, "label", TitleOf(id)), Theme.Small, tb, new RectangleF(cx - 60, cy + 22, 120, 18), Center);
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
        var N = Math.Max(2, (int)(Dbl(b, "floors") ?? 10)); var fm = Str(b, "floor", "floor").ToLowerInvariant(); var dm = Str(b, "door", "door").ToLowerInvariant();
        var lm = Str(b, "load").ToLowerInvariant(); var flt = Str(b, "fault").ToLowerInvariant();
        var ids = DevIds(b, new Metric { Id = fm, Keys = { (fm, 1) } }); if (ids.Count == 0) return 0;
        const float sh = 250; var top = y + 16; var bot = top + sh; const float car = 30; var h = sh + 82;
        float FloorY(double f) => bot - car / 2 - 2 - (float)((Math.Clamp(f, 1, N) - 1) / (N - 1)) * (sh - car - 4);   // tâm cabin ở tầng f
        Card(g, new RectangleF(x, y, w, h)); using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
        using (var gl = new Pen(Color.FromArgb(45, Theme.Border)) { DashStyle = DashStyle.Dot })
            for (var i = 1; i <= N; i++) { var fy = FloorY(i); g.DrawString(i.ToString(), Theme.Small, mb, new RectangleF(x + 8, fy - 8, 28, 16), new StringFormat { Alignment = StringAlignment.Far }); g.DrawLine(gl, x + 42, fy, x + w - 14, fy); }
        var n = ids.Count; var avail = w - 70; var cw = Math.Min(170f, avail / n); var sx = x + 52 + (avail - cw * n) / 2;
        for (var i = 0; i < n; i++)
        {
            var o = _devs[ids[i]]; var f = o.TryGetValue(fm, out var fv) ? fv : 1; var door = o.TryGetValue(dm, out var dv) && dv > 0;
            var bad = flt.Length > 0 && o.TryGetValue(flt, out var fl) && fl > 0;
            var shaft = new RectangleF(sx + i * cw + 14, top, cw - 28, sh);
            using (var sp = Theme.Round(shaft, 6)) using (var sb = new SolidBrush(Color.FromArgb(120, Theme.Panel2))) using (var pen = new Pen(Theme.Border, 1.5f)) { g.FillPath(sb, sp); g.DrawPath(pen, sp); }
            var col = bad ? Theme.Red : door ? Theme.Green : Theme.Accent;
            var cr = new RectangleF(shaft.X + 5, FloorY(f) - car / 2, shaft.Width - 10, car);
            using (var cp = Theme.Round(cr, 4)) using (var cb = new SolidBrush(col)) g.FillPath(cb, cp);
            // cửa cabin: hai cánh, mở thì tách ra
            var gap = door ? cr.Width * 0.28f : 1.5f; using (var dp = new Pen(Color.FromArgb(150, 0, 0, 0), 1.5f)) { g.DrawLine(dp, cr.X + cr.Width / 2 - gap / 2, cr.Y + 4, cr.X + cr.Width / 2 - gap / 2, cr.Bottom - 4); g.DrawLine(dp, cr.X + cr.Width / 2 + gap / 2, cr.Y + 4, cr.X + cr.Width / 2 + gap / 2, cr.Bottom - 4); }
            if (door) using (var inner = new SolidBrush(Color.FromArgb(110, 0, 0, 0))) g.FillRectangle(inner, cr.X + cr.Width / 2 - gap / 2 + 1, cr.Y + 4, gap - 2, cr.Height - 8);
            using (var wb = new SolidBrush(Color.White)) g.DrawString(Math.Round(f).ToString(), Theme.Small, wb, new RectangleF(cr.X, cr.Y - 17, cr.Width, 16), Center);
            g.DrawString(TitleOf(ids[i]), Theme.Semi, tb, new RectangleF(sx + i * cw, bot + 8, cw, 20), Center);
            var info = $"Tầng {Math.Round(f)} · {(bad ? "sự cố" : door ? "cửa mở" : "cửa đóng")}";
            using (var ib = new SolidBrush(bad ? Theme.Red : Theme.Muted)) g.DrawString(info, Theme.Small, ib, new RectangleF(sx + i * cw, bot + 30, cw, 18), Center);
            if (lm.Length > 0 && o.TryGetValue(lm, out var lv))
            {
                var lr = new RectangleF(sx + i * cw + 22, bot + 52, cw - 44, 6); var lf = (float)Math.Clamp(lv / 100, 0, 1);
                using (var tp = Theme.Round(lr, 3)) using (var tbr = new SolidBrush(Theme.Mix(Theme.Panel, Theme.Border, 0.8))) g.FillPath(tbr, tp);
                if (lf > 0.02) using (var fp = Theme.Round(new RectangleF(lr.X, lr.Y, lr.Width * lf, lr.Height), 3)) using (var fb = new SolidBrush(lf > 0.9 ? Theme.Yellow : Theme.Accent)) g.FillPath(fb, fp);
            }
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
        var W = Dbl(b, "w") ?? 120; var H = Dbl(b, "h") ?? 70; var (s, ox, ph) = Fit(W, H, x, w, 380); var h = ph + 24; var oy = y + 12;
        Card(g, new RectangleF(x, y, w, h));
        PointF P(double px, double py) => new(ox + (float)px * s, oy + (float)py * s);
        var t = (DateTime.Now - _t0).TotalSeconds; var pipeW = Math.Clamp(1.5f * s, 6f, 12f);
        foreach (var p in b.GetProperty("pipes").EnumerateArray())
        {
            var pts = p.GetProperty("pts").EnumerateArray().Select(q => P(q[0].GetDouble(), q[1].GetDouble())).ToArray(); var on = !p.TryGetProperty("on", out var oj) || (Val(oj.GetString()!) ?? 0) > 0;
            using (var pen = new Pen(Theme.Mix(Theme.Panel, Theme.Border, 1.0), pipeW) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawLines(pen, pts);
            using (var inner = new Pen(Theme.Mix(Theme.Panel2, on ? Theme.Accent : Theme.Panel, on ? 0.25 : 0.0), pipeW - 3) { LineJoin = LineJoin.Round }) g.DrawLines(inner, pts);
            if (on) using (var fp = new Pen(Theme.Accent, 2.5f) { DashPattern = new[] { 2.2f, 2.2f }, DashOffset = -(float)(t * 2.5 % 4.4) }) g.DrawLines(fp, pts);
        }
        using var tb = new SolidBrush(Theme.Text); using var mb = new SolidBrush(Theme.Muted);
        foreach (var n in b.GetProperty("nodes").EnumerateArray())
        {
            var kind = Str(n, "kind"); var m = n.TryGetProperty("metric", out var mj) ? M(mj.GetString()!) : null; var v = m != null ? Val(m.Id) : null; var lv = m != null ? LevelOf(m, v) : "";
            var alert = lv is "warn" or "bad"; var col = alert ? Lc(lv) : Theme.Accent;
            var cx = (float)(Dbl(n, "x") ?? 0); var cy = (float)(Dbl(n, "y") ?? 0); var label = Str(n, "label");
            if (kind is "tank" or "vessel")
            {
                var nw = (float)(Dbl(n, "w") ?? 16) * s; var nh = (float)(Dbl(n, "h") ?? 20) * s; var r = new RectangleF(P(cx, 0).X - nw / 2, P(0, cy).Y, nw, nh);
                using var path = Theme.Round(r, kind == "vessel" ? Math.Min(nw, nh) * 0.32f : Math.Min(10, nw / 5));
                using (var br = new SolidBrush(Theme.Panel2)) g.FillPath(br, path);
                var st = g.Save(); g.SetClip(path);
                if (kind == "tank" && m != null && v != null)
                {
                    var f = (float)Math.Clamp((v.Value - m.Min) / ((m.Max - m.Min) == 0 ? 1 : m.Max - m.Min), 0, 1); var top = r.Bottom - r.Height * f;
                    using var wave = new GraphicsPath(); var pts = new List<PointF> { new(r.Left - 2, r.Bottom + 2) };
                    for (var xx = r.Left - 2; xx <= r.Right + 2; xx += 3) pts.Add(new PointF(xx, top + (float)Math.Sin(xx / 9.0 + t * 2.2) * 1.8f));
                    pts.Add(new PointF(r.Right + 2, r.Bottom + 2)); wave.AddPolygon(pts.ToArray());
                    using var lb = new LinearGradientBrush(new RectangleF(r.X, top - 3, r.Width, r.Bottom - top + 6), Color.FromArgb(220, col), Color.FromArgb(140, Theme.Mix(col, Color.Black, 0.45)), 90f); g.FillPath(lb, wave);
                }
                else using (var vb = new LinearGradientBrush(r, Theme.Mix(Theme.Panel2, col, 0.18), Theme.Mix(Theme.Panel2, col, 0.42), 90f)) g.FillRectangle(vb, r);
                g.Restore(st);
                using (var hl = new Pen(Color.FromArgb(36, 255, 255, 255), 3)) g.DrawLine(hl, r.X + 7, r.Y + 10, r.X + 7, r.Bottom - 10);
                using (var pen = new Pen(alert ? col : Theme.Mix(Theme.Border, Theme.Accent, 0.35), 2)) g.DrawPath(pen, path);
                if (m != null)
                {
                    var txt = $"{Text(m, v)} {m.Unit}".Trim(); var tr = new RectangleF(r.X - 14, r.Y + r.Height / 2 - 10, r.Width + 28, 22);
                    using var shb = new SolidBrush(Color.FromArgb(130, 0, 0, 0)); g.DrawString(txt, Theme.Semi, shb, new RectangleF(tr.X + 1, tr.Y + 1, tr.Width, tr.Height), Center);
                    using var wb = new SolidBrush(Color.White); g.DrawString(txt, Theme.Semi, wb, tr, Center);
                }
                g.DrawString(label, Theme.Small, mb, new RectangleF(r.X - 30, r.Bottom + 4, r.Width + 60, 16), Center);
            }
            else if (kind == "pump")
            {
                var c = P(cx, cy); var run = (v ?? 0) > 0; var rr = Math.Clamp(2.6f * s, 13f, 20f); var pc = run ? Theme.Green : Theme.Muted;
                using (var br = new SolidBrush(Theme.Panel2)) g.FillEllipse(br, c.X - rr, c.Y - rr, rr * 2, rr * 2);
                using (var pen = new Pen(pc, 2.2f)) g.DrawEllipse(pen, c.X - rr, c.Y - rr, rr * 2, rr * 2);
                // cánh bơm quay khi chạy
                var st = g.Save(); g.TranslateTransform(c.X, c.Y); if (run) g.RotateTransform((float)(t * 240 % 360));
                using (var ib = new SolidBrush(pc)) for (var k = 0; k < 3; k++) { g.RotateTransform(120); g.FillPolygon(ib, new[] { new PointF(0, -rr * 0.72f), new PointF(rr * 0.28f, -rr * 0.1f), new PointF(-rr * 0.28f, -rr * 0.1f) }); }
                g.Restore(st);
                using (var hub = new SolidBrush(Theme.Panel)) g.FillEllipse(hub, c.X - 3, c.Y - 3, 6, 6);
                g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 50, c.Y + rr + 3, 100, 16), Center);
            }
            else if (kind == "valve")
            {
                var c = P(cx, cy); var open = (v ?? 0) > 0; var vs = Math.Clamp(2.2f * s, 8f, 13f); var vc = open ? Theme.Green : Theme.Red;
                using (var vb = new SolidBrush(Theme.Mix(Theme.Panel2, vc, 0.55))) g.FillPolygon(vb, new[] { new PointF(c.X - vs, c.Y - vs * 0.8f), new PointF(c.X + vs, c.Y + vs * 0.8f), new PointF(c.X + vs, c.Y - vs * 0.8f), new PointF(c.X - vs, c.Y + vs * 0.8f) });
                using (var vp = new Pen(vc, 2) { LineJoin = LineJoin.Round }) { g.DrawPolygon(vp, new[] { new PointF(c.X - vs, c.Y - vs * 0.8f), new PointF(c.X + vs, c.Y + vs * 0.8f), new PointF(c.X + vs, c.Y - vs * 0.8f), new PointF(c.X - vs, c.Y + vs * 0.8f) }); g.DrawLine(vp, c.X, c.Y, c.X, c.Y - vs * 1.5f); g.DrawLine(vp, c.X - vs * 0.6f, c.Y - vs * 1.5f, c.X + vs * 0.6f, c.Y - vs * 1.5f); }
                g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 50, c.Y + vs + 4, 100, 16), Center);
            }
            else
            {
                // cảm biến / chỉ số: ô có icon đại lượng + số
                var c = P(cx, cy); var txt = m != null ? $"{Text(m, v)} {m.Unit}".Trim() : label; var tw = g.MeasureString(txt, Theme.Semi).Width;
                var r = new RectangleF(c.X - (tw + 30) / 2, c.Y - 13, tw + 30, 26);
                using (var path = Theme.Round(r, 7)) using (var br = new SolidBrush(Theme.Panel2)) using (var pen = new Pen(alert ? col : Theme.Mix(Theme.Border, Theme.Accent, 0.35), 1.5f)) { g.FillPath(br, path); g.DrawPath(pen, path); }
                if (m != null) Icons.Draw(g, m.Icon, new RectangleF(r.X + 7, r.Y + 5, 16, 16), alert ? col : Theme.Accent);
                g.DrawString(txt, Theme.Semi, tb, r.X + 24, r.Y + 3);
                if (m != null) g.DrawString(label, Theme.Small, mb, new RectangleF(c.X - 60, r.Bottom + 3, 120, 16), Center);
            }
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
