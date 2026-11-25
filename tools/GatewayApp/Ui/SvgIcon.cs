using System.Drawing.Drawing2D;
using System.Globalization;
using System.Text.RegularExpressions;

namespace GatewayApp.Ui;

/// <summary>
/// Vẽ icon vector (cùng dữ liệu SVG với webapp, xem IconData.g.cs) bằng GDI+: nét bo tròn, đổi màu theo chủ đề, sắc nét ở mọi cỡ.
/// Hỗ trợ tập con SVG mà bộ icon dùng: path (M L H V C S Q T A Z, tương đối/tuyệt đối), circle, ellipse, rect (rx), line, polyline, polygon;
/// thuộc tính fill / fill-opacity / stroke / stroke-opacity / stroke-width. Hình đã phân tích được nhớ đệm.
/// </summary>
static class Icons
{
    sealed record Shape(GraphicsPath Path, bool Fill, float FillOp, bool Stroke, float StrokeOp, float? Width);
    sealed record Parsed(Shape[] Shapes, float Box, float Stroke);

    static readonly Dictionary<string, Parsed?> Cache = new();

    /// <summary>Dạng hình thiết bị: "3d" (mặc định, đổ khối) · "flat" (phẳng) · "line" (nét mảnh một màu như trước). Có thể đặt bằng biến môi trường GATEWAYAPP_ICONFORM.</summary>
    public static string RealForm { get; set; } = Environment.GetEnvironmentVariable("GATEWAYAPP_ICONFORM") is "flat" or "line" ? Environment.GetEnvironmentVariable("GATEWAYAPP_ICONFORM")! : "3d";
    static bool UseReal(string? id) => RealForm != "line" && RealIcon.Has(id);

    /// <summary>Có icon này không (đại lượng đo hoặc thiết bị).</summary>
    public static bool Has(string? id) => id != null && (IconData.Q.ContainsKey(id) || IconData.Device.ContainsKey(id));

    /// <summary>Mã icon THIẾT BỊ từ mẫu thiết bị đã chọn (ký hiệu cũ lưu trong cấu hình hoặc mã mẫu). Không rõ → "gear".</summary>
    public static string ForDevice(string? glyphOrId, string? template)
    {
        if (!string.IsNullOrEmpty(glyphOrId))
        {
            if (IconData.Device.ContainsKey(glyphOrId)) return glyphOrId;
            var t = DeviceTemplate.All.FirstOrDefault(x => x.Icon == glyphOrId);
            if (t != null && IconData.Device.ContainsKey(t.Id)) return t.Id;
        }
        return !string.IsNullOrEmpty(template) && IconData.Device.ContainsKey(template) ? template : "gear";
    }

    /// <summary>Vẽ icon vào ô r (giữ tỉ lệ, căn giữa). Mặc định bộ đại lượng đo (24×24, rồi tới bộ thiết bị); device = true → bộ thiết bị (48×48, giống webapp).</summary>
    public static void Draw(Graphics g, string? id, RectangleF r, Color c, float? stroke = null, bool device = false)
    {
        if (device && UseReal(id)) { RealIcon.Draw(g, id, r, RealForm == "flat"); return; }   // hình thiết bị thực tế (3D / phẳng), giống webapp
        var p = Get(id ?? "", device) ?? Get("chart", false);
        if (p == null || r.Width <= 0 || r.Height <= 0) return;
        var s = Math.Min(r.Width, r.Height) / p.Box;
        var st = g.Save();
        var mode = g.SmoothingMode; g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TranslateTransform(r.X + (r.Width - p.Box * s) / 2, r.Y + (r.Height - p.Box * s) / 2);
        g.ScaleTransform(s, s);
        var sw = stroke ?? p.Stroke;
        foreach (var sh in p.Shapes)
        {
            if (sh.Fill) { using var b = new SolidBrush(Color.FromArgb((int)(255 * sh.FillOp * c.A / 255f), c)); g.FillPath(b, sh.Path); }
            if (sh.Stroke)
            {
                using var pen = new Pen(Color.FromArgb((int)(255 * sh.StrokeOp * c.A / 255f), c), sh.Width ?? sw) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
                g.DrawPath(pen, sh.Path);
            }
        }
        g.SmoothingMode = mode;
        g.Restore(st);
    }

    /// <summary>Ô icon bo góc nền nhạt + icon màu nhấn (dùng cho thẻ thiết bị, chỉ số).</summary>
    public static void Badge(Graphics g, string? id, RectangleF r, Color c, float radius = 8, int alpha = 46, bool device = false)
    {
        if (device && UseReal(id)) { RealIcon.Draw(g, id, r, RealForm == "flat"); return; }   // hình thực tế tự đứng, không cần ô nền
        using (var path = Theme.Round(r, radius)) using (var b = new SolidBrush(Color.FromArgb(alpha, c))) g.FillPath(b, path);
        var pad = r.Width * (device ? 0.14f : 0.2f);
        Draw(g, id, new RectangleF(r.X + pad, r.Y + pad, r.Width - pad * 2, r.Height - pad * 2), c, null, device);
    }

    static Parsed? Get(string id, bool device)
    {
        var key = (device ? "d:" : "q:") + id;
        if (Cache.TryGetValue(key, out var p)) return p;
        p = device && IconData.Device.TryGetValue(id, out var d0) ? Parse(d0, 48, 2.2f)
            : IconData.Q.TryGetValue(id, out var q) ? Parse(q, 24, 1.8f)
            : IconData.Device.TryGetValue(id, out var d) ? Parse(d, 48, 2.2f) : null;
        Cache[key] = p;
        return p;
    }

    /* ------------------------------------------------------------ phân tích SVG */
    static readonly Regex Elem = new(@"<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*?)/?>", RegexOptions.CultureInvariant);
    static readonly Regex Attr = new(@"([\w-]+)\s*=\s*""([^""]*)""", RegexOptions.CultureInvariant);

    static float F(Dictionary<string, string> a, string k, float d = 0) =>
        a.TryGetValue(k, out var v) && float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var f) ? f : d;

    static Parsed Parse(string svg, float box, float stroke)
    {
        var list = new List<Shape>();
        foreach (Match m in Elem.Matches(svg))
        {
            var a = Attr.Matches(m.Groups[2].Value).ToDictionary(x => x.Groups[1].Value, x => x.Groups[2].Value);
            var gp = new GraphicsPath();
            try
            {
                switch (m.Groups[1].Value)
                {
                    case "path": PathData(gp, a.TryGetValue("d", out var d) ? d : ""); break;
                    case "circle": { var r = F(a, "r"); gp.AddEllipse(F(a, "cx") - r, F(a, "cy") - r, r * 2, r * 2); break; }
                    case "ellipse": { var rx = F(a, "rx"); var ry = F(a, "ry"); gp.AddEllipse(F(a, "cx") - rx, F(a, "cy") - ry, rx * 2, ry * 2); break; }
                    case "rect":
                    {
                        var rc = new RectangleF(F(a, "x"), F(a, "y"), F(a, "width"), F(a, "height"));
                        var rx = Math.Min(F(a, "rx", F(a, "ry")), Math.Min(rc.Width, rc.Height) / 2);
                        if (rx > 0.01f) { using var rp = Theme.Round(rc, rx); gp.AddPath(rp, false); } else gp.AddRectangle(rc);
                        break;
                    }
                    case "line": gp.AddLine(F(a, "x1"), F(a, "y1"), F(a, "x2"), F(a, "y2")); break;
                    case "polyline" or "polygon":
                    {
                        var n = Nums(a.TryGetValue("points", out var pts) ? pts : "");
                        var arr = Enumerable.Range(0, n.Count / 2).Select(i => new PointF(n[i * 2], n[i * 2 + 1])).ToArray();
                        if (arr.Length > 1) { gp.AddLines(arr); if (m.Groups[1].Value == "polygon") gp.CloseFigure(); }
                        break;
                    }
                }
            }
            catch (Exception e) when (e is FormatException or ArgumentException or IndexOutOfRangeException) { continue; }
            var fill = a.TryGetValue("fill", out var fv) && fv != "none";
            var strokeOn = !a.TryGetValue("stroke", out var sv) || sv != "none";
            list.Add(new Shape(gp, fill, fill ? F(a, "fill-opacity", 1) * F(a, "opacity", 1) : 0, strokeOn, F(a, "stroke-opacity", 1) * F(a, "opacity", 1),
                a.ContainsKey("stroke-width") ? F(a, "stroke-width", stroke) : null));
        }
        return new Parsed(list.ToArray(), box, stroke);
    }

    static List<float> Nums(string s) => Regex.Matches(s, @"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?").Select(x => float.Parse(x.Value, CultureInfo.InvariantCulture)).ToList();

    /// <summary>Bộ đọc dữ liệu path SVG (đọc từng ký tự để hiểu cả cờ cung viết dính "0 0112 0").</summary>
    sealed class Reader
    {
        readonly string _s; int _i;
        public Reader(string s) { _s = s; }
        void Skip() { while (_i < _s.Length && (char.IsWhiteSpace(_s[_i]) || _s[_i] == ',')) _i++; }
        public bool End { get { Skip(); return _i >= _s.Length; } }
        public bool NumberNext { get { Skip(); return _i < _s.Length && (char.IsDigit(_s[_i]) || _s[_i] is '-' or '+' or '.'); } }
        public char? Cmd() { Skip(); if (_i < _s.Length && char.IsLetter(_s[_i])) return _s[_i++]; return null; }
        public float Num()
        {
            Skip(); var st = _i;
            if (_i < _s.Length && _s[_i] is '-' or '+') _i++;
            var dot = false;
            while (_i < _s.Length && (char.IsDigit(_s[_i]) || (_s[_i] == '.' && !dot))) { if (_s[_i] == '.') dot = true; _i++; }
            if (_i < _s.Length && _s[_i] is 'e' or 'E') { _i++; if (_i < _s.Length && _s[_i] is '-' or '+') _i++; while (_i < _s.Length && char.IsDigit(_s[_i])) _i++; }
            if (st == _i) throw new FormatException("path");
            return float.Parse(_s.AsSpan(st, _i - st), NumberStyles.Float, CultureInfo.InvariantCulture);
        }
        public bool Flag() { Skip(); var c = _s[_i++]; return c == '1'; }
    }

    internal static void PathData(GraphicsPath gp, string d)
    {
        var r = new Reader(d);
        PointF cur = default, start = default, ctl = default; char prev = ' ';
        char cmd = ' ';
        while (!r.End)
        {
            var c = r.Cmd();
            if (c != null) cmd = c.Value;
            else if (cmd == ' ') return;
            var rel = char.IsLower(cmd);
            PointF P(float x, float y) => rel ? new PointF(cur.X + x, cur.Y + y) : new PointF(x, y);
            switch (char.ToUpperInvariant(cmd))
            {
                case 'M':
                    cur = start = P(r.Num(), r.Num()); gp.StartFigure();
                    cmd = rel ? 'l' : 'L';   // các cặp số sau M là L
                    break;
                case 'L': { var p = P(r.Num(), r.Num()); gp.AddLine(cur, p); cur = p; break; }
                case 'H': { var x = r.Num(); var p = new PointF(rel ? cur.X + x : x, cur.Y); gp.AddLine(cur, p); cur = p; break; }
                case 'V': { var y = r.Num(); var p = new PointF(cur.X, rel ? cur.Y + y : y); gp.AddLine(cur, p); cur = p; break; }
                case 'C': { var c1 = P(r.Num(), r.Num()); var c2 = P(r.Num(), r.Num()); var p = P(r.Num(), r.Num()); gp.AddBezier(cur, c1, c2, p); ctl = c2; cur = p; break; }
                case 'S':
                {
                    var c1 = char.ToUpperInvariant(prev) is 'C' or 'S' ? new PointF(2 * cur.X - ctl.X, 2 * cur.Y - ctl.Y) : cur;
                    var c2 = P(r.Num(), r.Num()); var p = P(r.Num(), r.Num()); gp.AddBezier(cur, c1, c2, p); ctl = c2; cur = p; break;
                }
                case 'Q': { var q = P(r.Num(), r.Num()); var p = P(r.Num(), r.Num()); Quad(gp, cur, q, p); ctl = q; cur = p; break; }
                case 'T':
                {
                    var q = char.ToUpperInvariant(prev) is 'Q' or 'T' ? new PointF(2 * cur.X - ctl.X, 2 * cur.Y - ctl.Y) : cur;
                    var p = P(r.Num(), r.Num()); Quad(gp, cur, q, p); ctl = q; cur = p; break;
                }
                case 'A':
                {
                    var rx = r.Num(); var ry = r.Num(); var rot = r.Num(); var large = r.Flag(); var sweep = r.Flag(); var p = P(r.Num(), r.Num());
                    Arc(gp, cur, p, rx, ry, rot, large, sweep); cur = p; break;
                }
                case 'Z': gp.CloseFigure(); cur = start; break;
                default: return;
            }
            prev = cmd;
            if (char.ToUpperInvariant(cmd) == 'Z' && r.NumberNext) return;
        }
    }

    static void Quad(GraphicsPath gp, PointF p0, PointF q, PointF p) =>
        gp.AddBezier(p0, new PointF(p0.X + 2f / 3 * (q.X - p0.X), p0.Y + 2f / 3 * (q.Y - p0.Y)), new PointF(p.X + 2f / 3 * (q.X - p.X), p.Y + 2f / 3 * (q.Y - p.Y)), p);

    /// <summary>Cung elip SVG (tham số điểm cuối) → các đoạn Bézier bậc 3 (mỗi đoạn ≤ 90°).</summary>
    static void Arc(GraphicsPath gp, PointF p0, PointF p1, double rx, double ry, double rotDeg, bool large, bool sweep)
    {
        if (rx == 0 || ry == 0 || (p0.X == p1.X && p0.Y == p1.Y)) { gp.AddLine(p0, p1); return; }
        rx = Math.Abs(rx); ry = Math.Abs(ry);
        var phi = rotDeg * Math.PI / 180; var cos = Math.Cos(phi); var sin = Math.Sin(phi);
        var dx = (p0.X - p1.X) / 2.0; var dy = (p0.Y - p1.Y) / 2.0;
        var x1 = cos * dx + sin * dy; var y1 = -sin * dx + cos * dy;
        var lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
        if (lam > 1) { var k = Math.Sqrt(lam); rx *= k; ry *= k; }
        var num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        var den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        var co = (large == sweep ? -1 : 1) * Math.Sqrt(Math.Max(0, num / den));
        var cxp = co * rx * y1 / ry; var cyp = -co * ry * x1 / rx;
        var cx = cos * cxp - sin * cyp + (p0.X + p1.X) / 2.0; var cy = sin * cxp + cos * cyp + (p0.Y + p1.Y) / 2.0;
        double Ang(double ux, double uy, double vx, double vy)
        {
            var a = Math.Atan2(ux * vy - uy * vx, ux * vx + uy * vy);
            return a;
        }
        var t1 = Ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
        var dt = Ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
        if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
        var segs = (int)Math.Ceiling(Math.Abs(dt) / (Math.PI / 2) - 1e-9);
        var step = dt / Math.Max(1, segs);
        var kk = 4.0 / 3 * Math.Tan(step / 4);
        PointF E(double t)
        {
            var ex = rx * Math.Cos(t); var ey = ry * Math.Sin(t);
            return new PointF((float)(cx + cos * ex - sin * ey), (float)(cy + sin * ex + cos * ey));
        }
        var tt = t1; var from = p0;
        for (var i = 0; i < Math.Max(1, segs); i++)
        {
            var a = tt; var b = tt + step;
            // điểm điều khiển: P(a) + k·P'(a), P(b) − k·P'(b) (P' theo tham số t của elip đã xoay)
            var c1 = Offset(E(a), cos, sin, -kk * rx * Math.Sin(a), kk * ry * Math.Cos(a));
            var c2 = Offset(E(b), cos, sin, kk * rx * Math.Sin(b), -kk * ry * Math.Cos(b));
            var to = i == segs - 1 ? p1 : E(b);
            gp.AddBezier(from, c1, c2, to);
            from = to; tt = b;
        }
    }

    static PointF Offset(PointF p, double cos, double sin, double ex, double ey) =>
        new((float)(p.X + cos * ex - sin * ey), (float)(p.Y + sin * ex + cos * ey));
}
