using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace Plciot.Solution.Conveyor;

/// <summary>Đồ thị đường có tô nền dưới đường, kiểu panel "Time series" của Grafana. Giữ N điểm gần nhất.</summary>
public sealed class TimeSeries : FrameworkElement
{
    readonly List<double> _v = new();
    public int Capacity { get; set; } = 300;
    public Color Line { get; set; } = Color.FromRgb(0x73, 0xbf, 0x69);
    public string Unit { get; set; } = "";

    public void Add(double v)
    {
        _v.Add(v);
        if (_v.Count > Capacity) _v.RemoveAt(0);
        InvalidateVisual();
    }

    public int Count => _v.Count;

    static readonly Typeface Face = new("Segoe UI");
    static FormattedText Text(string s, Brush b, double size) =>
        new(s, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, Face, size, b, 1.0);

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        if (w < 40 || h < 30) return;
        var grid = new Pen(new SolidColorBrush(Color.FromRgb(0x2c, 0x32, 0x35)), 1);
        var muted = new SolidColorBrush(Color.FromRgb(0x8e, 0x8e, 0x9e));
        const double left = 38, bottom = 4, top = 6;
        var plotH = h - bottom - top; var plotW = w - left - 4;

        var max = _v.Count == 0 ? 1 : Math.Max(1, _v.Max());
        max = Math.Ceiling(max * 1.15);                 // chừa khoảng trống phía trên đường
        for (var i = 0; i <= 3; i++)
        {
            var y = top + plotH * i / 3;
            dc.DrawLine(grid, new Point(left, y), new Point(w - 4, y));
            var label = Text((max * (3 - i) / 3).ToString("0.#", CultureInfo.InvariantCulture), muted, 10);
            dc.DrawText(label, new Point(left - 6 - label.Width, y - label.Height / 2));
        }
        if (_v.Count < 2) { dc.DrawText(Text("Đang thu thập dữ liệu…", muted, 11), new Point(left + 8, top + 8)); return; }

        // đồ thị dồn về bên phải: điểm mới nhất luôn ở mép phải, như Grafana khi chọn "Last N minutes"
        var x0 = left + plotW * (1 - (_v.Count - 1.0) / (Capacity - 1.0));
        Point Q(int i) => new(x0 + plotW * i / (Capacity - 1.0), top + plotH * (1 - _v[i] / max));

        var area = new StreamGeometry();
        using (var c = area.Open())
        {
            c.BeginFigure(new Point(Q(0).X, top + plotH), true, true);
            for (var i = 0; i < _v.Count; i++) c.LineTo(Q(i), true, false);
            c.LineTo(new Point(Q(_v.Count - 1).X, top + plotH), true, false);
        }
        area.Freeze();
        var fill = new LinearGradientBrush(Color.FromArgb(0x55, Line.R, Line.G, Line.B), Color.FromArgb(0x05, Line.R, Line.G, Line.B), 90);
        dc.DrawGeometry(fill, null, area);

        var path = new StreamGeometry();
        using (var c = path.Open())
        {
            c.BeginFigure(Q(0), false, false);
            for (var i = 1; i < _v.Count; i++) c.LineTo(Q(i), true, true);
        }
        path.Freeze();
        dc.DrawGeometry(null, new Pen(new SolidColorBrush(Line), 1.6) { LineJoin = PenLineJoin.Round }, path);
        var last = Q(_v.Count - 1);
        dc.DrawEllipse(new SolidColorBrush(Line), null, last, 3, 3);
    }
}
