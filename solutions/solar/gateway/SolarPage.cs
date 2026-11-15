using System.Drawing.Drawing2D;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Trang "Năng lượng" của giải pháp solar: sơ đồ dòng PV → inverter → tải / lưới / pin + chỉ số sản lượng.
/// Đọc số từ đúng các field của thiết bị đã khai báo (TryValue "thiết bị.field"); tên field nhận diện giống webapp solar
/// (pv_kw, load_kw, grid_kw, batt_kw, batt_soc, e_today, e_total — kW hoặc W). Chạy --demo mà chưa có field solar thì hiện số mẫu.
/// </summary>
sealed class SolarPage : UserControl
{
    // (tên field, hệ số đổi ra kW/kWh/%); khoá đầu tiên có số liệu thắng
    static readonly (string, double)[] Pv = { ("pv_kw", 1), ("pv_power", 1), ("solar_kw", 1), ("pac_kw", 1), ("pv_w", 1e-3), ("pac", 1e-3), ("kw", 1) };
    static readonly (string, double)[] Load = { ("load_kw", 1), ("home_kw", 1), ("consumption_kw", 1), ("load_w", 1e-3), ("load", 1e-3) };
    static readonly (string, double)[] Grid = { ("grid_kw", 1), ("grid_w", 1e-3), ("grid", 1e-3) };
    static readonly (string, double)[] Batt = { ("batt_kw", 1), ("bat_kw", 1), ("batt_w", 1e-3), ("bat_w", 1e-3) };
    static readonly (string, double)[] Soc = { ("batt_soc", 1), ("bat_soc", 1), ("soc", 1) };
    static readonly (string, double)[] Today = { ("e_today", 1), ("yield_today", 1), ("kwh_today", 1), ("today_kwh", 1) };
    static readonly (string, double)[] Total = { ("e_total", 1), ("yield_total", 1), ("kwh_total", 1), ("total_kwh", 1), ("kwh", 1) };

    readonly IGatewayApp _app;
    readonly System.Windows.Forms.Timer _t = new() { Interval = 700 };
    readonly bool _demoArg = Environment.GetCommandLineArgs().Contains("--demo");
    double _phase;
    bool _demoShown;

    public SolarPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; DoubleBuffered = true; ResizeRedraw = true;
        _t.Tick += (_, _) => { _phase += 0.35; Invalidate(); };
        _t.Start();
        Disposed += (_, _) => _t.Dispose();
    }

    Dictionary<string, double> Read()
    {
        var d = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in _app.Config.Pack)
            if (_app.TryValue(UiMetaStore.Key(p.Child, p.Field), out var v)) d[p.Field.ToLowerInvariant()] = v;
        return d;
    }

    static double? First(Dictionary<string, double> d, (string, double)[] keys)
    {
        foreach (var (k, m) in keys) if (d.TryGetValue(k, out var v)) return v * m;
        return null;
    }

    Dictionary<string, double> Source()
    {
        var d = Read();
        _demoShown = false;
        if (d.Count == 0 && _demoArg)
        {
            _demoShown = true;
            var t = DateTime.Now; var sun = Math.Max(0.15, Math.Sin((t.Hour + t.Minute / 60.0 - 6) / 12 * Math.PI));
            var pv = sun * 4.2 + Math.Sin(_phase / 5) * 0.15; var load = 1.1 + 0.4 * Math.Sin(_phase / 9);
            var net = pv - load; var batt = Math.Clamp(net * 0.6, -1.5, 1.5);
            d["pv_kw"] = pv; d["load_kw"] = load; d["batt_kw"] = batt; d["batt_soc"] = 62 + 15 * Math.Sin(_phase / 40);
            d["grid_kw"] = -(net - batt); d["e_today"] = 12.4 + t.Hour * 0.35; d["e_total"] = 18420;
        }
        return d;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics; Theme.Quality(g);
        var d = Source();
        double? pv = First(d, Pv), load = First(d, Load), grid = First(d, Grid), batt = First(d, Batt), soc = First(d, Soc);
        var today = First(d, Today); var total = First(d, Total);
        double? self = pv is > 0.005 && load != null ? Math.Min(100, Math.Round(Math.Min(pv.Value, load.Value) / pv.Value * 100)) : null;

        var pad = 20; var w = Width - pad * 2;
        // --- hàng chỉ số
        var kpis = new (string, string, string)[]
        {
            ("Công suất hiện tại", pv == null ? "—" : Theme.Num(pv.Value), "kW"),
            ("Sản lượng hôm nay", today == null ? "—" : Theme.Num(today.Value), "kWh"),
            ("Tổng sản lượng", total == null ? "—" : total.Value.ToString("0"), "kWh"),
            ("Tự dùng", self == null ? "—" : self.Value.ToString("0"), "%"),
        };
        var kw = (w - 3 * 12) / 4f;
        for (var i = 0; i < 4; i++)
        {
            var r = new RectangleF(pad + i * (kw + 12), pad, kw, 84);
            using var path = Theme.Round(r, 10); using var br = new SolidBrush(Theme.Panel); using var pen = new Pen(Theme.Border);
            g.FillPath(br, path); g.DrawPath(pen, path);
            using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text); using var ab = new SolidBrush(Theme.Accent);
            g.DrawString(kpis[i].Item1, Theme.Small, mb, r.X + 14, r.Y + 10);
            g.DrawString(kpis[i].Item2, Theme.Huge, i == 0 ? ab : tb, r.X + 12, r.Y + 28);
            var sz = g.MeasureString(kpis[i].Item2, Theme.Huge);
            g.DrawString(kpis[i].Item3, Theme.Normal, mb, r.X + 14 + sz.Width, r.Y + 50);
        }

        // --- sơ đồ dòng năng lượng
        var top = pad + 84 + 18;
        var area = new RectangleF(pad, top, w, Height - top - pad);
        using (var path = Theme.Round(area, 12)) using (var br = new SolidBrush(Theme.Panel)) using (var pen = new Pen(Theme.Border)) { g.FillPath(br, path); g.DrawPath(pen, path); }
        using (var tb = new SolidBrush(Theme.Text)) g.DrawString("Dòng năng lượng", Theme.Title, tb, area.X + 16, area.Y + 12);
        var fresh = d.Count > 0;
        using (var mb = new SolidBrush(fresh ? Theme.Green : Theme.Yellow))
        {
            var s = _demoShown ? "● Dữ liệu mẫu (demo)" : fresh ? "● Đang nhận dữ liệu" : "▲ Chưa có dữ liệu — khai báo field pv_kw, load_kw, grid_kw, batt_kw, batt_soc ở trang Thiết bị";
            var sz = g.MeasureString(s, Theme.Small);
            g.DrawString(s, Theme.Small, mb, area.Right - sz.Width - 16, area.Y + 16);
        }

        var bw = Math.Min(190f, area.Width / 4.2f); var bh = 78f;
        var cx = area.X + area.Width / 2; var cy = area.Y + 52 + (area.Height - 52) / 2 - 10;
        var gapY = Math.Min(130f, (area.Height - 52 - bh * 2) / 2 + 20);
        var inv = new RectangleF(cx - 46, cy - 30, 92, 60);
        var nPv = new RectangleF(cx - bw - 90, cy - gapY - bh / 2 - 10, bw, bh);
        var nLoad = new RectangleF(cx + 90, cy - gapY - bh / 2 - 10, bw, bh);
        var nGrid = new RectangleF(cx + 90, cy + gapY - bh / 2 + 10, bw, bh);
        var nBatt = new RectangleF(cx - bw - 90, cy + gapY - bh / 2 + 10, bw, bh);

        Wire(g, Mid(nPv, 'b'), new PointF(Mid(nPv, 'b').X, cy), new PointF(inv.X, cy), Dir(pv) > 0 ? 1 : 0, Theme.Accent);
        Wire(g, new PointF(inv.Right, cy), new PointF(Mid(nLoad, 'b').X, cy), Mid(nLoad, 'b'), Dir(load) > 0 ? 1 : 0, Theme.Teal);
        Wire(g, Mid(nGrid, 't'), new PointF(Mid(nGrid, 't').X, cy), new PointF(inv.Right, cy), Dir(grid) > 0 ? 1 : (Dir(grid) < 0 ? -1 : 0), Color.FromArgb(157, 143, 255));
        Wire(g, Mid(nBatt, 't'), new PointF(Mid(nBatt, 't').X, cy), new PointF(inv.X, cy), -Dir(batt), Theme.Green);

        using (var path = Theme.Round(inv, 12)) using (var br = new SolidBrush(Theme.Panel2)) using (var pen = new Pen(Theme.Border, 1.5f)) { g.FillPath(br, path); g.DrawPath(pen, path); }
        using (var tb = new SolidBrush(Theme.Text)) { var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }; g.DrawString("INVERTER", Theme.Semi, tb, inv, sf); }

        Node(g, nPv, "☀  Pin mặt trời", pv == null ? "—" : Theme.Num(pv.Value), "kW", Theme.Accent);
        Node(g, nLoad, "⌂  Tải", load == null ? "—" : Theme.Num(load.Value), "kW", Theme.Teal);
        Node(g, nGrid, "⚡  Lưới điện", grid == null ? "—" : Theme.Num(Math.Abs(grid.Value)), grid == null ? "kW" : grid < -0.005 ? "kW · bán lên lưới" : "kW · mua từ lưới", Color.FromArgb(157, 143, 255));
        Node(g, nBatt, "▮  Pin lưu trữ", soc != null ? soc.Value.ToString("0") + "%" : batt == null ? "—" : Theme.Num(Math.Abs(batt.Value)),
            soc != null ? (batt == null ? "" : batt > 0.005 ? "đang sạc" : batt < -0.005 ? "đang xả" : "chờ") : "kW", Theme.Green);
    }

    static int Dir(double? v) => v is { } x && Math.Abs(x) > 0.005 ? Math.Sign(x) : 0;
    static PointF Mid(RectangleF r, char side) => side == 'b' ? new PointF(r.X + r.Width / 2, r.Bottom) : new PointF(r.X + r.Width / 2, r.Y);

    /// <summary>Dây a→b→c (gấp khúc); dir &gt; 0: chấm chạy a→c, &lt; 0: chạy c→a, 0: dây tĩnh.</summary>
    void Wire(Graphics g, PointF a, PointF b, PointF c, int dir, Color color)
    {
        using var basePen = new Pen(Theme.Border, 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawLines(basePen, new[] { a, b, c });
        if (dir == 0) return;
        using var pen = new Pen(color, 3.5f) { DashStyle = DashStyle.Custom, DashPattern = new float[] { 1.7f, 2.3f }, DashOffset = (float)(dir > 0 ? -_phase * 3 : _phase * 3), StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawLines(pen, new[] { a, b, c });
    }

    static void Node(Graphics g, RectangleF r, string label, string value, string unit, Color color)
    {
        using var path = Theme.Round(r, 12); using var br = new SolidBrush(Theme.Panel2); using var pen = new Pen(color, 1.8f);
        g.FillPath(br, path); g.DrawPath(pen, path);
        using var mb = new SolidBrush(Theme.Muted); using var tb = new SolidBrush(Theme.Text);
        g.DrawString(label, Theme.Semi, tb, r.X + 12, r.Y + 8);
        g.DrawString(value, Theme.Big, tb, r.X + 10, r.Y + 28);
        var sz = g.MeasureString(value, Theme.Big);
        g.DrawString(unit, Theme.Small, mb, r.X + 12 + sz.Width, r.Y + 46);
    }
}
