using System.Drawing.Drawing2D;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace GatewayApp.Ui;

/// <summary>
/// Vẽ icon thiết bị THỰC TẾ (IconReal.g.cs, cùng bản vẽ với webapp/icons-real.js) bằng GDI+: nhiều màu, gradient tuyến tính (dạng 3D), nét đứt,
/// chữ (màn LCD, nhãn), phép quay. Khác Icons (SvgIcon.cs) chỉ vẽ MỘT màu theo chủ đề. Hình đã phân tích được nhớ đệm.
/// Tập con SVG hỗ trợ: g, path, circle, ellipse, rect, line, polygon, polyline, text; fill / fill-opacity / stroke / stroke-opacity / stroke-width /
/// stroke-linecap / stroke-linejoin / stroke-dasharray / opacity / transform="rotate(a cx cy)"; màu #rgb #rrggbb rgba() var(--x,#màu) url(#gradient).
/// </summary>
static class RealIcon
{
    sealed record Stop(float Off, Color C);
    sealed record Grad(Stop[] Stops, float Angle);

    sealed class Item
    {
        public GraphicsPath Path = new();
        public Color? Fill; public string? FillGrad; public float FillOp = 1;
        public Color? Stroke; public float StrokeOp = 1, Width = 1;
        public LineCap Cap = LineCap.Flat; public LineJoin Join = LineJoin.Miter; public float[]? Dash;
        public float Opacity = 1;
        public string? Text; public float X, Y, FontSize = 10; public bool Bold, Mono; public StringAlignment Anchor = StringAlignment.Near;
    }

    sealed class Style
    {
        public readonly Dictionary<string, string> A = new();
        public float Opacity = 1;
        public Style Clone() { var s = new Style { Opacity = Opacity }; foreach (var kv in A) s.A[kv.Key] = kv.Value; return s; }
    }

    static readonly string[] Inherited = { "fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "font-size", "font-weight", "font-family", "text-anchor" };
    static readonly Dictionary<string, Item[]> Cache = new();
    static Dictionary<string, Grad>? _grads;

    public static bool Has(string? id) => id != null && IconReal.D3.ContainsKey(id);

    /// <summary>Vẽ icon vào ô r (giữ tỉ lệ vuông, căn giữa). flat = dạng phẳng; dim = làm xám mờ (thiết bị đang tắt / mất kết nối).</summary>
    public static void Draw(Graphics g, string? id, RectangleF r, bool flat = false, bool dim = false)
    {
        if (id == null || r.Width <= 0 || r.Height <= 0) return;
        var items = Get(id, flat);
        if (items == null) return;
        var s = Math.Min(r.Width, r.Height) / 48f;
        var st = g.Save();
        var sm = g.SmoothingMode; g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TranslateTransform(r.X + (r.Width - 48 * s) / 2, r.Y + (r.Height - 48 * s) / 2);
        g.ScaleTransform(s, s);
        foreach (var it in items)
        {
            if (it.Text != null) { DrawText(g, it, dim); continue; }
            using (var brush = FillBrush(it, dim)) if (brush != null) g.FillPath(brush, it.Path);
            if (it.Stroke is { } sc && it.Width > 0)
            {
                using var pen = new Pen(Fade(sc, it.StrokeOp * it.Opacity, dim), it.Width) { StartCap = it.Cap, EndCap = it.Cap, LineJoin = it.Join };
                if (it.Dash != null) pen.DashPattern = it.Dash.Select(v => Math.Max(v, 0.01f) / it.Width).ToArray();
                g.DrawPath(pen, it.Path);
            }
        }
        g.SmoothingMode = sm;
        g.Restore(st);
    }

    static Color Fade(Color c, float alpha, bool dim)
    {
        var a = Math.Clamp(c.A / 255f * alpha, 0f, 1f);
        if (!dim) return Color.FromArgb((int)Math.Round(255 * a), c);
        var gray = (int)(c.R * .3 + c.G * .59 + c.B * .11);
        return Color.FromArgb((int)Math.Round(255 * a * .62), (c.R + gray * 3) / 4, (c.G + gray * 3) / 4, (c.B + gray * 3) / 4);
    }

    static Brush? FillBrush(Item it, bool dim)
    {
        if (it.FillGrad != null && Grads.TryGetValue(it.FillGrad, out var gr))
        {
            var b = it.Path.GetBounds();
            var stops = gr.Stops.Select(x => (x.Off, C: Fade(x.C, it.FillOp * it.Opacity, dim))).ToArray();
            if (b.Width < 0.01f || b.Height < 0.01f || stops.Length < 2) return new SolidBrush(stops[0].C);
            var lb = new LinearGradientBrush(b, stops[0].C, stops[^1].C, gr.Angle, false);
            lb.InterpolationColors = new ColorBlend(stops.Length) { Colors = stops.Select(x => x.C).ToArray(), Positions = stops.Select(x => x.Off).ToArray() };
            return lb;
        }
        return it.Fill is { } c ? new SolidBrush(Fade(c, it.FillOp * it.Opacity, dim)) : null;
    }

    static void DrawText(Graphics g, Item it, bool dim)
    {
        using var ff = new FontFamily(it.Mono ? "Consolas" : "Arial");
        var style = it.Bold ? FontStyle.Bold : FontStyle.Regular;
        if (!ff.IsStyleAvailable(style)) style = FontStyle.Regular;
        using var font = new Font(ff, it.FontSize, style, GraphicsUnit.Pixel);
        var ascent = ff.GetCellAscent(style) * it.FontSize / ff.GetEmHeight(style);
        using var sf = (StringFormat)StringFormat.GenericTypographic.Clone();
        sf.Alignment = it.Anchor;
        using var br = new SolidBrush(Fade(it.Fill ?? Color.Black, it.FillOp * it.Opacity, dim));
        var mode = g.TextRenderingHint; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
        g.DrawString(it.Text, font, br, it.X, it.Y - ascent, sf);
        g.TextRenderingHint = mode;
    }

    /* ------------------------------------------------------------ gradient */
    static Dictionary<string, Grad> Grads => _grads ??= ParseGrads();

    static Dictionary<string, Grad> ParseGrads()
    {
        var d = new Dictionary<string, Grad>();
        var doc = XDocument.Parse("<root>" + IconReal.Defs + "</root>");
        foreach (var e in doc.Descendants().Where(x => x.Name.LocalName is "linearGradient" or "radialGradient"))
        {
            var id = (string?)e.Attribute("id"); if (id == null) continue;
            var stops = e.Elements().Where(x => x.Name.LocalName == "stop").Select(s =>
            {
                TryColor((string?)s.Attribute("stop-color") ?? "#000", out var c);
                var op = float.TryParse((string?)s.Attribute("stop-opacity"), NumberStyles.Float, CultureInfo.InvariantCulture, out var o) ? o : 1f;
                return new Stop(Num((string?)s.Attribute("offset"), 0), Color.FromArgb((int)Math.Round(c.A * op), c));
            }).ToArray();
            if (stops.Length == 0) continue;
            var horizontal = Num((string?)e.Attribute("x2"), 0) > Num((string?)e.Attribute("x1"), 0) && Num((string?)e.Attribute("y2"), 0) <= Num((string?)e.Attribute("y1"), 0);
            d[id] = new Grad(stops, horizontal ? 0f : 90f);   // radialGradient (hình cầu cũ) tạm vẽ dọc sáng→tối
        }
        return d;
    }

    /* ------------------------------------------------------------ phân tích SVG */
    static Item[]? Get(string id, bool flat)
    {
        var key = (flat ? "f:" : "3:") + id;
        if (Cache.TryGetValue(key, out var v)) return v;
        var src = (flat ? IconReal.Flat : IconReal.D3).TryGetValue(id, out var s) ? s : null;
        Item[]? items = null;
        if (src != null)
        {
            try { var list = new List<Item>(); Walk(XDocument.Parse(src).Root!, new Style(), null, list); items = list.ToArray(); }
            catch (System.Xml.XmlException) { items = null; }
        }
        Cache[key] = items ?? Array.Empty<Item>();
        return Cache[key];
    }

    static float Num(string? s, float d) => s != null && float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var f) ? f : d;
    static float A(XElement e, string k, float d = 0) => Num((string?)e.Attribute(k), d);

    static void Walk(XElement e, Style inh, Matrix? m, List<Item> list)
    {
        var st = inh.Clone();
        foreach (var k in Inherited) if (e.Attribute(k) is { } at) st.A[k] = at.Value;
        if (e.Attribute("opacity") is { } op) st.Opacity *= Num(op.Value, 1);
        var mat = m;
        if (e.Attribute("transform") is { } tr)
        {
            var rm = Regex.Match(tr.Value, @"rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)");
            if (rm.Success)
            {
                mat = m?.Clone() ?? new Matrix();
                mat.RotateAt(Num(rm.Groups[1].Value, 0), new PointF(Num(rm.Groups[2].Value, 0), Num(rm.Groups[3].Value, 0)), MatrixOrder.Prepend);
            }
        }
        switch (e.Name.LocalName)
        {
            case "svg" or "g":
                foreach (var c in e.Elements()) Walk(c, st, mat, list);
                return;
            case "defs": return;
        }
        var it = new Item { Opacity = st.Opacity };
        var gp = it.Path;
        try
        {
            switch (e.Name.LocalName)
            {
                case "path": Icons.PathData(gp, (string?)e.Attribute("d") ?? ""); break;
                case "circle": { var r = A(e, "r"); gp.AddEllipse(A(e, "cx") - r, A(e, "cy") - r, r * 2, r * 2); break; }
                case "ellipse": { var rx = A(e, "rx"); var ry = A(e, "ry"); gp.AddEllipse(A(e, "cx") - rx, A(e, "cy") - ry, rx * 2, ry * 2); break; }
                case "rect":
                {
                    var rc = new RectangleF(A(e, "x"), A(e, "y"), A(e, "width"), A(e, "height"));
                    var rx = Math.Min(A(e, "rx", A(e, "ry")), Math.Min(rc.Width, rc.Height) / 2);
                    if (rx > 0.01f) { using var rp = Theme.Round(rc, rx); gp.AddPath(rp, false); } else gp.AddRectangle(rc);
                    break;
                }
                case "line": gp.AddLine(A(e, "x1"), A(e, "y1"), A(e, "x2"), A(e, "y2")); break;
                case "polyline" or "polygon":
                {
                    var n = Regex.Matches((string?)e.Attribute("points") ?? "", @"-?(?:\d+\.?\d*|\.\d+)").Select(x => float.Parse(x.Value, CultureInfo.InvariantCulture)).ToList();
                    var arr = Enumerable.Range(0, n.Count / 2).Select(i => new PointF(n[i * 2], n[i * 2 + 1])).ToArray();
                    if (arr.Length > 1) { gp.AddLines(arr); if (e.Name.LocalName == "polygon") gp.CloseFigure(); }
                    break;
                }
                case "text":
                    it.Text = e.Value; it.X = A(e, "x"); it.Y = A(e, "y");
                    it.FontSize = Num(st.A.GetValueOrDefault("font-size"), 10);
                    it.Bold = Num(st.A.GetValueOrDefault("font-weight"), 400) >= 600;
                    it.Mono = (st.A.GetValueOrDefault("font-family") ?? "").Contains("mono", StringComparison.OrdinalIgnoreCase);
                    it.Anchor = st.A.GetValueOrDefault("text-anchor") == "middle" ? StringAlignment.Center : StringAlignment.Near;
                    break;
                default: return;
            }
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or IndexOutOfRangeException) { return; }
        if (mat != null && it.Text == null) gp.Transform(mat);

        var fill = st.A.GetValueOrDefault("fill", "#000000");
        if (fill.StartsWith("url(#", StringComparison.Ordinal)) it.FillGrad = fill[5..fill.IndexOf(')')];
        else if (TryColor(fill, out var fc)) it.Fill = fc;
        it.FillOp = Num(st.A.GetValueOrDefault("fill-opacity"), 1);
        if (it.Text == null)
        {
            if (st.A.TryGetValue("stroke", out var sv) && TryColor(sv, out var sc)) it.Stroke = sc;
            it.StrokeOp = Num(st.A.GetValueOrDefault("stroke-opacity"), 1);
            it.Width = Num(st.A.GetValueOrDefault("stroke-width"), 1);
            it.Cap = st.A.GetValueOrDefault("stroke-linecap") == "round" ? LineCap.Round : LineCap.Flat;
            it.Join = st.A.GetValueOrDefault("stroke-linejoin") == "round" ? LineJoin.Round : LineJoin.Miter;
            if (st.A.TryGetValue("stroke-dasharray", out var da))
                it.Dash = Regex.Matches(da, @"-?(?:\d+\.?\d*|\.\d+)").Select(x => float.Parse(x.Value, CultureInfo.InvariantCulture)).ToArray() is { Length: > 0 } arr ? arr : null;
        }
        list.Add(it);
    }

    /// <summary>#rgb, #rrggbb, rgb()/rgba(), var(--x,#màu) (lấy màu dự phòng), currentColor; none → false.</summary>
    static bool TryColor(string s, out Color c)
    {
        c = Color.Black; s = s.Trim();
        if (s.Length == 0 || s == "none") return false;
        var v = Regex.Match(s, @"^var\([^,]+,\s*(.+)\)$");
        if (v.Success) s = v.Groups[1].Value.Trim();
        if (s.Equals("currentColor", StringComparison.OrdinalIgnoreCase)) { c = Color.FromArgb(0x9a, 0xa9, 0xbb); return true; }
        if (s[0] == '#')
        {
            var h = s[1..];
            if (h.Length == 3) h = string.Concat(h.Select(ch => $"{ch}{ch}"));
            if (h.Length == 6 && int.TryParse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var n)) { c = Color.FromArgb(255, (n >> 16) & 255, (n >> 8) & 255, n & 255); return true; }
            return false;
        }
        var m = Regex.Match(s, @"^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$");
        if (m.Success)
        {
            var a = m.Groups[4].Success ? Num(m.Groups[4].Value, 1) : 1f;
            c = Color.FromArgb((int)Math.Round(255 * Math.Clamp(a, 0f, 1f)), (int)Num(m.Groups[1].Value, 0), (int)Num(m.Groups[2].Value, 0), (int)Num(m.Groups[3].Value, 0));
            return true;
        }
        var named = Color.FromName(s);
        if (named.IsKnownColor) { c = named; return true; }
        return false;
    }
}
