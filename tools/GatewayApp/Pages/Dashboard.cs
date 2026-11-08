using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Những gì các trang cần từ cửa sổ chính (tách ra để trang không biết chi tiết host).</summary>
public interface IGatewayApp
{
    ScadaConfig Config { get; }
    UiMetaStore Meta { get; }
    HistoryStore History { get; }
    bool Running { get; }
    /// <summary>Giá trị mới nhất theo "child.field" (đơn vị kỹ thuật, đã chia Scale). Thiếu = chưa nhận.</summary>
    bool TryValue(string key, out double v);
    /// <summary>Gửi lệnh ghi {child,key,v} qua đúng đường điều khiển của gateway. Trả về null nếu thành công, ngược lại mã lỗi.</summary>
    Task<string?> WriteAsync(string child, string field, double value);
    /// <summary>Lưu cấu hình; đang chạy thì khởi động lại để Pack/giao thức mới có hiệu lực.</summary>
    Task ApplyAsync(string why);
    void Toast(string text, bool error = false);
}

/// <summary>Thẻ của một thiết bị con: mỗi field là một widget (bồn, đồng hồ, công tắc, thanh trượt, số).</summary>
sealed class DeviceCard : Card
{
    sealed record W(string Key, string Kind, Control Ctl, Action<double?> Set);
    readonly List<W> _w = new();
    public string Child { get; }

    public DeviceCard(string child, IList<PackMap> fields, IGatewayApp app, Action<string> select, Action<string> edit)
    {
        Child = child;
        var dm = app.Meta.Device(child);
        Title = string.IsNullOrWhiteSpace(dm?.Title) ? child : dm!.Title;
        Sub = Title != child ? child : $"{fields.Count} field";
        var gear = new FlatButton { Caption = "⚙", Width = 30, Height = 26, Font = Theme.Normal, Anchor = AnchorStyles.Top | AnchorStyles.Right };
        gear.Click += (_, _) => edit(child);
        Controls.Add(gear);
        Resize += (_, _) => gear.Location = new Point(Width - gear.Width - 10, 6);
        var flow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = true, BackColor = Color.Transparent, Margin = Padding.Empty };
        foreach (var p in fields)
        {
            var key = UiMetaStore.Key(child, p.Field);
            var rs = FieldMeta.ResolveFull(p, app.Meta.Get(child, p.Field));
            var (kind, unit, min, max, title) = (rs.Kind, rs.Unit, rs.Min, rs.Max, rs.Title);
            Control ctl; Action<double?> set;
            switch (kind)
            {
                case "tank":
                {
                    var t = new TankView { Label = title, Unit = unit, Min = min, Max = max, Margin = new Padding(2), Low = rs.Low ?? 15, High = rs.High ?? 92 };
                    t.Click += (_, _) => select(key);
                    ctl = t; set = v => t.Value = v ?? double.NaN; break;
                }
                case "gauge":
                {
                    var gg = new ArcGauge { Label = title, Unit = unit, Min = min, Max = max, Margin = new Padding(2) };
                    gg.Click += (_, _) => select(key);
                    ctl = gg; set = v => gg.Value = v ?? double.NaN; break;
                }
                case "toggle":
                {
                    var row = new Panel { Size = new Size(316, 40), Margin = new Padding(2), BackColor = Color.Transparent };
                    var lbl = new Label { Text = title, ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = false, Bounds = new Rectangle(4, 0, 150, 40), TextAlign = ContentAlignment.MiddleLeft };
                    var stt = new Label { Text = "—", ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, Bounds = new Rectangle(154, 0, 92, 40), TextAlign = ContentAlignment.MiddleRight };
                    var sw = new ToggleSwitch { Location = new Point(250, 7) };
                    string onT = rs.OnText, offT = rs.OffText;
                    void Txt() { stt.Text = sw.On ? onT : offT; stt.ForeColor = sw.On ? Theme.Green : Theme.Muted; }
                    sw.Toggled += _ => Txt();
                    var pc = p; var ch = child;
                    sw.Toggled += async on =>
                    {
                        var err = await app.WriteAsync(ch, pc.Field, on ? 1 : 0);
                        if (err != null) { app.Toast($"Lệnh {ch}.{pc.Field} bị từ chối: {err}", true); sw.On = !on; }
                    };
                    lbl.Click += (_, _) => select(key);
                    row.Controls.Add(lbl); row.Controls.Add(stt); row.Controls.Add(sw);
                    ctl = row; set = v => { if (v.HasValue) { sw.On = v.Value >= 1; Txt(); } }; break;
                }
                case "slider":
                {
                    var row = new Panel { Size = new Size(316, 62), Margin = new Padding(2), BackColor = Color.Transparent };
                    var lbl = new Label { Text = title, ForeColor = Theme.Text, Font = Theme.Normal, AutoSize = false, Bounds = new Rectangle(4, 0, 200, 26), TextAlign = ContentAlignment.MiddleLeft };
                    var val = new Label { Text = "—", ForeColor = Theme.Accent, Font = Theme.Semi, AutoSize = false, Bounds = new Rectangle(204, 0, 108, 26), TextAlign = ContentAlignment.MiddleRight };
                    var sl = new SliderBar { Min = min, Max = max, Step = Math.Max(0.1, (max - min) / 100 >= 1 ? 1 : 0.1), Bounds = new Rectangle(0, 28, 316, 30) };
                    var pc = p; var ch = child; var u = unit;
                    sl.Changing += v => val.Text = Theme.Num(v) + " " + u;
                    sl.Committed += async v =>
                    {
                        var err = await app.WriteAsync(ch, pc.Field, v);
                        if (err != null) app.Toast($"Lệnh {ch}.{pc.Field} = {Theme.Num(v)} bị từ chối: {err}", true);
                        else app.Toast($"Đã gửi {ch}.{pc.Field} = {Theme.Num(v)} {u}".TrimEnd());
                    };
                    lbl.Click += (_, _) => select(key);
                    row.Controls.AddRange(new Control[] { lbl, val, sl });
                    ctl = row; set = v => { if (v.HasValue) { sl.Value = v.Value; val.Text = Theme.Num(v.Value) + " " + u; } }; break;
                }
                default:
                {
                    var k = new KpiBox { Label = title, Unit = unit, Margin = new Padding(2) };
                    k.Click += (_, _) => select(key);
                    ctl = k; set = v => k.Value = v ?? double.NaN; break;
                }
            }
            flow.Controls.Add(ctl); _w.Add(new W(key, kind, ctl, set));
        }
        var panelH = _w.Where(x => x.Ctl is Panel).Sum(x => x.Ctl.Height + 4);
        var cellRows = (_w.Count(x => x.Ctl is not Panel) + 1) / 2;
        Size = new Size(358, 40 + 14 + cellRows * 144 + panelH);
        Controls.Add(flow);
        Margin = new Padding(0, 0, 14, 14);
    }

    public void Tick(IGatewayApp app)
    {
        foreach (var w in _w) w.Set(app.TryValue(w.Key, out var v) ? v : null);
    }
}

/// <summary>Trang Tổng quan: thẻ theo thiết bị + biểu đồ lịch sử. Chạy offline hoàn toàn.</summary>
sealed class DashboardPage : UserControl
{
    readonly IGatewayApp _app;
    readonly FlowLayoutPanel _flow = new() { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Theme.Bg, Padding = new Padding(0, 0, 0, 0) };
    readonly Card _chartCard = new() { Title = "Biểu đồ", Dock = DockStyle.Fill };
    readonly LineChart _chart = new() { Dock = DockStyle.Fill };
    readonly Panel _empty = new() { Size = new Size(640, 200), BackColor = Color.Transparent };
    readonly List<DeviceCard> _cards = new();
    string _sig = "";
    string? _selected;
    int _window = 300;

    public DashboardPage(IGatewayApp app)
    {
        _app = app; BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        var lay = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1, BackColor = Theme.Bg };
        lay.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        lay.RowStyles.Add(new RowStyle(SizeType.Absolute, 300));
        lay.Controls.Add(_flow, 0, 0);
        _chartCard.Controls.Add(_chart);
        foreach (var (txt, sec) in new[] { ("6 giờ", 21600), ("1 giờ", 3600), ("5 phút", 300) })
        {
            var b = new FlatButton { Caption = txt, Width = 70, Height = 26, Font = Theme.Small, Anchor = AnchorStyles.Top | AnchorStyles.Right };
            b.Click += (_, _) => { _window = sec; _chart.WindowSec = sec; Refresh(); };
            _chartCard.Controls.Add(b); b.BringToFront();
        }
        lay.Controls.Add(_chartCard, 0, 1);
        Controls.Add(lay);
        _chart.WindowSec = _window;
        var et = new Label { Text = "Chưa có thiết bị nào", ForeColor = Theme.Text, Font = Theme.Big, AutoSize = true, Location = new Point(0, 8), BackColor = Color.Transparent };
        var es = new Label { Text = "Bấm nút bên dưới, chọn loại thiết bị vật lý (bồn nước, bơm, cảm biến, van, động cơ…),\nchỉnh thanh ghi D rồi lưu — thẻ sẽ hiện ngay ở đây. Dùng Demo để xem thử không cần PLC.", ForeColor = Theme.Muted, Font = Theme.Normal, AutoSize = true, Location = new Point(0, 56), BackColor = Color.Transparent };
        var eb = new FlatButton { Caption = "＋  Thêm thiết bị ngoại vi", Primary = true, Width = 240, Height = 40, Location = new Point(0, 128) };
        eb.Click += (_, _) => AddDevice();
        _empty.Controls.AddRange(new Control[] { et, es, eb });
        _flow.Controls.Add(_empty);
        // nút chọn khoảng thời gian bám mép phải thẻ
        _chartCard.Resize += (_, _) =>
        {
            var x = _chartCard.Width - 14;
            foreach (var b in _chartCard.Controls.OfType<FlatButton>()) { x -= b.Width + 6; b.Location = new Point(x, 6); }
        };
    }

    void AddDevice() { if (DeviceDialog.Run(_app, FindForm()!, null, out var c)) { Rebuild(); _ = _app.ApplyAsync($"Đã thêm thiết bị {c}"); } }
    void EditDevice(string child) { if (DeviceDialog.Run(_app, FindForm()!, child, out var c, out var del)) { Rebuild(); _ = _app.ApplyAsync(del ? $"Đã xoá thiết bị {c}" : $"Đã lưu thiết bị {c}"); } }

    string Signature() => string.Join("|", _app.Config.Pack.Select(p => $"{p.Child}.{p.Field}@{p.Address}x{p.Scale}"))
        + "#" + string.Join("|", _app.Meta.Map.Select(kv => kv.Key + ":" + kv.Value.Kind + kv.Value.Unit + kv.Value.Title + kv.Value.Min + kv.Value.Max + kv.Value.OnText + kv.Value.OffText + kv.Value.Low + kv.Value.High))
        + "#" + string.Join("|", _app.Meta.Devices.Select(kv => kv.Key + kv.Value.Title + kv.Value.Template));

    public void Rebuild()
    {
        _sig = Signature();
        _flow.SuspendLayout();
        foreach (var c in _cards) { _flow.Controls.Remove(c); c.Dispose(); }
        _cards.Clear();
        var groups = _app.Config.Pack.GroupBy(p => p.Child).ToList();
        _empty.Visible = groups.Count == 0;
        foreach (var g in groups)
        {
            var card = new DeviceCard(g.Key, g.ToList(), _app, k => { _selected = k; UpdateChart(); }, EditDevice);
            _cards.Add(card); _flow.Controls.Add(card);
        }
        _flow.ResumeLayout();
        var first = _app.Config.Pack.FirstOrDefault(p => FieldMeta.Resolve(p, _app.Meta.Get(p.Child, p.Field)).Kind is not "toggle");
        if (_selected == null || !_app.Config.Pack.Any(p => UiMetaStore.Key(p.Child, p.Field) == _selected))
            _selected = first == null ? null : UiMetaStore.Key(first.Child, first.Field);
        UpdateChart();
    }

    void UpdateChart()
    {
        _chart.All.Clear();
        if (_selected != null)
        {
            var p = _app.Config.Pack.FirstOrDefault(x => UiMetaStore.Key(x.Child, x.Field) == _selected);
            if (p != null)
            {
                var (_, unit, _, _, title) = FieldMeta.Resolve(p, _app.Meta.Get(p.Child, p.Field));
                var s = new LineChart.Series { Name = $"{p.Child}.{title}", Unit = unit, Color = Theme.Teal };
                _chartCard.Title = "Biểu đồ"; _chartCard.Sub = $"{p.Child}.{p.Field} — bấm một thẻ để đổi";
                s.Pts = _app.History.Get(_selected, _window);
                _chart.All.Add(s);
            }
        }
        _chart.Invalidate();
    }

    public void Tick()
    {
        if (Signature() != _sig) Rebuild();
        foreach (var c in _cards) c.Tick(_app);
        _chartCard.Visible = _cards.Count > 0;
        UpdateChart();
    }
}
