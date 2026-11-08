using System.Drawing.Drawing2D;

namespace GatewayApp.Ui;

/// <summary>Control tự vẽ, chống nháy.</summary>
abstract class Painted : Control
{
    protected Painted()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        ForeColor = Theme.Text;
    }
}

/// <summary>Thẻ bo góc có tiêu đề (giống panel của Grafana).</summary>
class Card : Panel
{
    string _title = "", _sub = "";
    public string Title { get => _title; set { _title = value; Invalidate(); } }
    public string Sub { get => _sub; set { _sub = value; Invalidate(); } }

    public Card()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Bg;
        Padding = new Padding(14, 40, 14, 12);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        g.Clear(Theme.Bg);
        var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using var path = Theme.Round(r, 10);
        using (var b = new SolidBrush(Theme.Panel)) g.FillPath(b, path);
        using (var p = new Pen(Theme.Border)) g.DrawPath(p, path);
        if (_title.Length > 0)
        {
            TextRenderer.DrawText(g, _title, Theme.Title, new Point(14, 9), Theme.Text, TextFormatFlags.NoPadding);
            if (_sub.Length > 0)
            {
                var w = TextRenderer.MeasureText(g, _title, Theme.Title, new Size(9999, 99), TextFormatFlags.NoPadding).Width;
                TextRenderer.DrawText(g, _sub, Theme.Small, new Point(22 + w, 13), Theme.Muted, TextFormatFlags.NoPadding);
            }
        }
    }
}

/// <summary>Nút phẳng bo góc. Primary = xanh; Danger = đỏ; mặc định = xám viền.</summary>
sealed class FlatButton : Painted
{
    bool _hot, _down;
    public bool Primary { get; set; }
    public bool Danger { get; set; }
    public string Caption { get => Text; set { Text = value; Invalidate(); } }

    public FlatButton() { Cursor = Cursors.Hand; Height = 34; Width = 120; Font = Theme.Semi; }
    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var baseC = Danger ? Theme.Red : Primary ? Theme.Accent : Theme.Panel2;
        var c = !Enabled ? Theme.Mix(baseC, Theme.Bg, .6) : _down ? Theme.Mix(baseC, Color.Black, .2) : _hot ? Theme.Mix(baseC, Color.White, .12) : baseC;
        using var path = Theme.Round(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 7);
        using (var b = new SolidBrush(c)) g.FillPath(b, path);
        if (!Primary && !Danger) using (var p = new Pen(Theme.Border)) g.DrawPath(p, path);
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, Enabled ? Color.White : Theme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
    }
}

/// <summary>Chip trạng thái: chấm màu + chữ.</summary>
sealed class StatusChip : Painted
{
    string _text = ""; Color _dot = Theme.Muted;
    public string Caption { get => _text; set { _text = value; AutoW(); Invalidate(); } }
    public Color Dot { get => _dot; set { _dot = value; Invalidate(); } }
    public StatusChip() { Height = 28; Font = Theme.Small; }
    void AutoW() => Width = TextRenderer.MeasureText(_text, Font).Width + 36;
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        using var path = Theme.Round(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 14);
        using (var b = new SolidBrush(Theme.Panel2)) g.FillPath(b, path);
        using (var p = new Pen(Theme.Border)) g.DrawPath(p, path);
        using (var b = new SolidBrush(_dot)) g.FillEllipse(b, 11, Height / 2f - 4, 8, 8);
        TextRenderer.DrawText(g, _text, Font, new Rectangle(24, 0, Width - 24, Height), Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }
}

/// <summary>Công tắc bật/tắt.</summary>
sealed class ToggleSwitch : Painted
{
    bool _on;
    public bool On { get => _on; set { if (_on == value) return; _on = value; Invalidate(); } }
    public event Action<bool>? Toggled;
    public ToggleSwitch() { Size = new Size(50, 26); Cursor = Cursors.Hand; }
    protected override void OnClick(EventArgs e)
    {
        base.OnClick(e);
        if (!Enabled) return;
        _on = !_on; Invalidate(); Toggled?.Invoke(_on);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var r = new RectangleF(1, 1, Width - 3, Height - 3);
        using var path = Theme.Round(r, r.Height / 2);
        using (var b = new SolidBrush(_on ? Theme.Green : Theme.Border)) g.FillPath(b, path);
        var d = r.Height - 6;
        var x = _on ? r.Right - d - 3 : r.X + 3;
        using (var b = new SolidBrush(Color.White)) g.FillEllipse(b, x, r.Y + 3, d, d);
    }
}

/// <summary>Thanh trượt đặt giá trị; chỉ phát <see cref="Committed"/> khi thả chuột (không gửi lệnh liên tục).</summary>
sealed class SliderBar : Painted
{
    double _min = 0, _max = 100, _val, _step = 1; bool _drag;
    public double Min { get => _min; set { _min = value; Invalidate(); } }
    public double Max { get => _max; set { _max = value; Invalidate(); } }
    public double Step { get => _step; set => _step = value <= 0 ? 1 : value; }
    public double Value { get => _val; set { if (_drag) return; _val = Math.Clamp(value, _min, _max); Invalidate(); } }
    public event Action<double>? Changing, Committed;
    public SliderBar() { Height = 28; Cursor = Cursors.Hand; }

    double FromX(int x)
    {
        var f = Math.Clamp((x - 10.0) / Math.Max(1, Width - 20), 0, 1);
        var v = _min + f * (_max - _min);
        return Math.Clamp(Math.Round(v / _step) * _step, _min, _max);
    }
    protected override void OnMouseDown(MouseEventArgs e) { if (!Enabled) return; _drag = true; _val = FromX(e.X); Changing?.Invoke(_val); Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseMove(MouseEventArgs e) { if (_drag) { _val = FromX(e.X); Changing?.Invoke(_val); Invalidate(); } base.OnMouseMove(e); }
    protected override void OnMouseUp(MouseEventArgs e) { if (_drag) { _drag = false; Committed?.Invoke(_val); Invalidate(); } base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var f = _max > _min ? (_val - _min) / (_max - _min) : 0;
        var x = 10 + (float)f * (Width - 20);
        var y = Height / 2f;
        using (var p = new Pen(Theme.Border, 6) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawLine(p, 10, y, Width - 10, y);
        using (var p = new Pen(Enabled ? Theme.Accent : Theme.Muted, 6) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawLine(p, 10, y, Math.Max(10.1f, x), y);
        using (var b = new SolidBrush(Color.White)) g.FillEllipse(b, x - 9, y - 9, 18, 18);
        using (var b = new SolidBrush(Theme.Accent)) g.FillEllipse(b, x - 4, y - 4, 8, 8);
    }
}

/// <summary>Đồng hồ cung tròn.</summary>
sealed class ArcGauge : Painted
{
    double _v = double.NaN;
    public double Value { get => _v; set { if (Equals(_v, value)) return; _v = value; Invalidate(); } }
    public double Min { get; set; }
    public double Max { get; set; } = 100;
    public string Unit { get; set; } = "";
    public string Label { get; set; } = "";
    public Color? Fixed { get; set; }
    public ArcGauge() { Size = new Size(150, 140); Cursor = Cursors.Hand; }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var s = Math.Min(Width - 20, Height - 36);
        var rect = new RectangleF((Width - s) / 2f, 8, s, s);
        using (var p = new Pen(Theme.Border, 10) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawArc(p, rect, 150, 240);
        var has = !double.IsNaN(_v);
        var f = has && Max > Min ? Math.Clamp((_v - Min) / (Max - Min), 0, 1) : 0;
        if (has && f > 0.002)
        {
            var c = Fixed ?? (f < .7 ? Theme.Green : f < .9 ? Theme.Yellow : Theme.Red);
            using var p = new Pen(c, 10) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawArc(p, rect, 150, (float)(240 * f));
        }
        var txt = has ? Theme.Num(_v) : "—";
        TextRenderer.DrawText(g, txt, Theme.Big, new Rectangle(0, (int)rect.Y + (int)(s * .28), Width, 36), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Unit, Theme.Small, new Rectangle(0, (int)rect.Y + (int)(s * .28) + 34, Width, 18), Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Label, Theme.Normal, new Rectangle(0, Height - 24, Width, 22), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>Bồn nước có sóng; đổi màu khi quá thấp / quá cao.</summary>
sealed class TankView : Painted
{
    double _v = double.NaN, _shown;
    float _phase;
    readonly System.Windows.Forms.Timer _t = new() { Interval = 50 };
    public double Value { get => _v; set { _v = value; } }
    public double Min { get; set; }
    public double Max { get; set; } = 100;
    public string Unit { get; set; } = "%";
    public string Label { get; set; } = "";
    public double Low { get; set; } = 15;
    public double High { get; set; } = 92;

    public TankView()
    {
        Size = new Size(150, 140); Cursor = Cursors.Hand;
        _t.Tick += (_, _) =>
        {
            if (!Visible || !IsHandleCreated) return;
            _phase += 0.25f;
            if (!double.IsNaN(_v)) _shown += (_v - _shown) * 0.25;
            Invalidate();
        };
        _t.Start();
    }
    protected override void Dispose(bool disposing) { if (disposing) _t.Dispose(); base.Dispose(disposing); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var tank = new RectangleF(Width / 2f - 42, 6, 84, Height - 34);
        using var path = Theme.Round(tank, 10);
        using (var b = new SolidBrush(Theme.Panel2)) g.FillPath(b, path);
        var has = !double.IsNaN(_v);
        var f = has && Max > Min ? Math.Clamp((_shown - Min) / (Max - Min), 0, 1) : 0;
        var color = !has ? Theme.Muted : _v <= Low ? Theme.Red : _v >= High ? Theme.Yellow : Theme.Teal;
        if (f > 0.001)
        {
            var top = tank.Bottom - (float)f * tank.Height;
            var state = g.Save();
            g.SetClip(path);
            using var wave = new GraphicsPath();
            var pts = new List<PointF> { new(tank.Left - 2, tank.Bottom + 2) };
            for (var x = tank.Left - 2; x <= tank.Right + 2; x += 3)
                pts.Add(new PointF(x, top + (float)Math.Sin(x / 11.0 + _phase) * 2.2f));
            pts.Add(new PointF(tank.Right + 2, tank.Bottom + 2));
            wave.AddPolygon(pts.ToArray());
            using (var b = new LinearGradientBrush(new RectangleF(tank.Left, top - 4, tank.Width, tank.Bottom - top + 8),
                       Color.FromArgb(210, color), Color.FromArgb(120, Theme.Mix(color, Color.Black, .45)), 90f)) g.FillPath(b, wave);
            g.Restore(state);
        }
        using (var p = new Pen(Theme.Border, 2)) g.DrawPath(p, path);
        using (var p = new Pen(Color.FromArgb(70, Theme.Muted)))
            for (var i = 1; i < 4; i++) g.DrawLine(p, tank.Left + 6, tank.Top + tank.Height * i / 4, tank.Left + 16, tank.Top + tank.Height * i / 4);
        var txt = has ? Theme.Num(_v) + " " + Unit : "—";
        TextRenderer.DrawText(g, txt, Theme.Semi, Rectangle.Round(tank), Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        if (has)
        {
            var st = _v <= Low ? "Mức thấp" : _v >= High ? "Mức cao" : "Bình thường";
            TextRenderer.DrawText(g, st, Theme.Small, new Rectangle((int)tank.Left, (int)tank.Bottom - 22, (int)tank.Width, 18), Color.FromArgb(230, 255, 255, 255), TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        }
        TextRenderer.DrawText(g, Label, Theme.Normal, new Rectangle(0, Height - 24, Width, 22), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>Số lớn (KPI) có nhãn.</summary>
sealed class KpiBox : Painted
{
    double _v = double.NaN;
    public double Value { get => _v; set { if (Equals(_v, value)) return; _v = value; Invalidate(); } }
    public string Unit { get; set; } = "";
    public string Label { get; set; } = "";
    public KpiBox() { Size = new Size(150, 140); Cursor = Cursors.Hand; }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var txt = double.IsNaN(_v) ? "—" : Theme.Num(_v);
        TextRenderer.DrawText(g, txt, Theme.Huge, new Rectangle(0, 28, Width, 48), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Unit, Theme.Small, new Rectangle(0, 78, Width, 18), Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Label, Theme.Normal, new Rectangle(0, Height - 24, Width, 22), Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

/// <summary>Biểu đồ đường theo thời gian (tự co giãn trục, lưới, lơ lửng xem giá trị). Không cần thư viện ngoài.</summary>
sealed class LineChart : Painted
{
    public sealed class Series
    {
        public string Name = ""; public Color Color = Theme.Accent; public string Unit = "";
        public List<(DateTime T, double V)> Pts = new();
    }
    public List<Series> All { get; } = new();
    public int WindowSec { get; set; } = 300;
    int _hoverX = -1;
    public LineChart() { MinimumSize = new Size(200, 120); Cursor = Cursors.Cross; }
    protected override void OnMouseMove(MouseEventArgs e) { _hoverX = e.X; Invalidate(); base.OnMouseMove(e); }
    protected override void OnMouseLeave(EventArgs e) { _hoverX = -1; Invalidate(); base.OnMouseLeave(e); }

    static double NiceStep(double range, int n)
    {
        var raw = range / n; var mag = Math.Pow(10, Math.Floor(Math.Log10(raw))); var r = raw / mag;
        return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        var plot = new Rectangle(52, 28, Width - 52 - 14, Height - 28 - 28);
        if (plot.Width < 20 || plot.Height < 20) return;
        var now = DateTime.Now; var t0 = now.AddSeconds(-WindowSec);
        var vis = All.Select(s => (s, p: s.Pts.Where(x => x.T >= t0).ToList())).ToList();
        var vals = vis.SelectMany(x => x.p.Select(q => q.V)).ToList();
        double lo = vals.Count > 0 ? vals.Min() : 0, hi = vals.Count > 0 ? vals.Max() : 1;
        if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
        var pad = (hi - lo) * .12; lo -= pad; hi += pad;
        var step = NiceStep(hi - lo, 4);
        lo = Math.Floor(lo / step) * step; hi = Math.Ceiling(hi / step) * step;

        // lưới + nhãn trục Y
        using (var gp = new Pen(Color.FromArgb(46, 255, 255, 255)))
            for (var v = lo; v <= hi + 1e-9; v += step)
            {
                var y = plot.Bottom - (float)((v - lo) / (hi - lo) * plot.Height);
                g.DrawLine(gp, plot.Left, y, plot.Right, y);
                TextRenderer.DrawText(g, Theme.Num(v), Theme.Small, new Rectangle(0, (int)y - 9, plot.Left - 6, 18), Theme.Muted, TextFormatFlags.Right | TextFormatFlags.NoPadding);
            }
        for (var i = 0; i <= 4; i++)
        {
            var x = plot.Left + plot.Width * i / 4;
            var t = t0.AddSeconds(WindowSec * i / 4.0);
            TextRenderer.DrawText(g, t.ToString(WindowSec > 7200 ? "HH:mm" : "HH:mm:ss"), Theme.Small, new Rectangle(Math.Min(x - 36, Width - 76), plot.Bottom + 6, 72, 16), Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
        }
        if (vals.Count == 0)
        {
            TextRenderer.DrawText(g, "Chưa có dữ liệu — hãy chạy gateway hoặc bật chế độ Demo", Theme.Normal, plot, Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            return;
        }

        PointF Map(DateTime t, double v) => new(plot.Left + (float)((t - t0).TotalSeconds / WindowSec * plot.Width),
            plot.Bottom - (float)((v - lo) / (hi - lo) * plot.Height));

        var state = g.Save(); g.SetClip(plot);
        var first = true;
        foreach (var (s, p) in vis)
        {
            if (p.Count < 2) continue;
            var pts = p.Select(q => Map(q.T, q.V)).ToArray();
            if (first)
            {
                var area = pts.Concat(new[] { new PointF(pts[^1].X, plot.Bottom), new PointF(pts[0].X, plot.Bottom) }).ToArray();
                using var fb = new LinearGradientBrush(plot, Color.FromArgb(70, s.Color), Color.FromArgb(0, s.Color), 90f);
                g.FillPolygon(fb, area);
                first = false;
            }
            using var pen = new Pen(s.Color, 2f) { LineJoin = LineJoin.Round };
            g.DrawLines(pen, pts);
        }
        g.Restore(state);

        // chú thích
        var lx = plot.Left;
        foreach (var s in All)
        {
            using (var b = new SolidBrush(s.Color)) g.FillRectangle(b, lx, 12, 12, 3);
            var w = TextRenderer.MeasureText(s.Name, Theme.Small).Width;
            TextRenderer.DrawText(g, s.Name, Theme.Small, new Point(lx + 16, 6), Theme.Text, TextFormatFlags.NoPadding);
            lx += w + 36;
        }

        // lơ lửng
        if (_hoverX >= plot.Left && _hoverX <= plot.Right)
        {
            var tt = t0.AddSeconds((_hoverX - plot.Left) / (double)plot.Width * WindowSec);
            using (var p = new Pen(Color.FromArgb(120, Theme.Muted)) { DashStyle = DashStyle.Dash }) g.DrawLine(p, _hoverX, plot.Top, _hoverX, plot.Bottom);
            var lines = new List<string> { tt.ToString("HH:mm:ss") };
            foreach (var (s, p) in vis)
            {
                if (p.Count == 0) continue;
                var near = p.OrderBy(q => Math.Abs((q.T - tt).TotalSeconds)).First();
                lines.Add($"{s.Name}: {Theme.Num(near.V)} {s.Unit}".TrimEnd());
            }
            var sz = new Size(lines.Max(l => TextRenderer.MeasureText(l, Theme.Small).Width) + 16, lines.Count * 17 + 8);
            var bx = _hoverX + 12 + sz.Width > Width ? _hoverX - 12 - sz.Width : _hoverX + 12;
            var r = new Rectangle(bx, plot.Top + 4, sz.Width, sz.Height);
            using (var path = Theme.Round(r, 6)) { using var b = new SolidBrush(Color.FromArgb(235, Theme.Panel2)); g.FillPath(b, path); using var p = new Pen(Theme.Border); g.DrawPath(p, path); }
            for (var i = 0; i < lines.Count; i++)
                TextRenderer.DrawText(g, lines[i], Theme.Small, new Point(r.X + 8, r.Y + 4 + i * 17), i == 0 ? Theme.Muted : Theme.Text, TextFormatFlags.NoPadding);
        }
    }
}

/// <summary>Mục thanh bên.</summary>
sealed class NavButton : Painted
{
    bool _hot;
    public string Icon { get; set; } = "";
    public string Caption { get; set; } = "";
    public bool Selected { get; set; }
    public NavButton() { Height = 44; Dock = DockStyle.Top; Cursor = Cursors.Hand; }
    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Theme.Quality(g);
        g.Clear(Theme.Side);
        if (Selected || _hot)
        {
            using var path = Theme.Round(new RectangleF(8, 3, Width - 16, Height - 6), 8);
            using var b = new SolidBrush(Selected ? Color.FromArgb(48, Theme.Accent) : Color.FromArgb(24, 255, 255, 255));
            g.FillPath(b, path);
        }
        if (Selected) using (var b = new SolidBrush(Theme.Accent)) g.FillRectangle(b, 0, 10, 3, Height - 20);
        TextRenderer.DrawText(g, Icon, new Font("Segoe UI Symbol", 12f), new Rectangle(20, 0, 30, Height), Selected ? Theme.Accent : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, Caption, Theme.Semi, new Rectangle(54, 0, Width - 54, Height), Selected ? Color.White : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
    }
}
