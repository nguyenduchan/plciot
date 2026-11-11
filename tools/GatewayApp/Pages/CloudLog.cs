using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Trang Nhật ký: mọi dữ liệu đi/đến của gateway (PLC→GW, GW→Cloud, Cloud→GW, GW→PLC).</summary>
sealed class LogPage : UserControl
{
    readonly DataGridView _tbl = new() { Dock = DockStyle.Fill };
    readonly CheckBox _dedup = new() { Text = "Ẩn dữ liệu lặp", Checked = true, AutoSize = true, ForeColor = Theme.Text, Font = Theme.Normal, Margin = new Padding(14, 9, 0, 0) };
    readonly CheckBox _scroll = new() { Text = "Tự cuộn", Checked = true, AutoSize = true, ForeColor = Theme.Text, Font = Theme.Normal, Margin = new Padding(14, 9, 0, 0) };
    readonly Dictionary<string, string> _last = new();
    readonly List<(DateTime T, string Dir, string Ch, string Text)> _pending = new();

    public LogPage()
    {
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_tbl);
        _tbl.Columns.Add("t", "Giờ"); _tbl.Columns.Add("d", "Hướng"); _tbl.Columns.Add("c", "Kênh / topic"); _tbl.Columns.Add("x", "Dữ liệu");
        _tbl.Columns[0].Width = 110; _tbl.Columns[1].Width = 130; _tbl.Columns[2].Width = 220; _tbl.Columns[3].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _tbl.DefaultCellStyle.Font = Theme.Mono;
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6) };
        var clear = new FlatButton { Caption = "Xoá bảng", Width = 100 };
        clear.Click += (_, _) => _tbl.Rows.Clear();
        bar.Controls.AddRange(new Control[] { clear, _dedup, _scroll });
        var card = new Card { Title = "Nhật ký giao dịch", Sub = "PLC→GW · GW→Cloud · Cloud→GW · GW→PLC", Dock = DockStyle.Fill, Padding = new Padding(2, 40, 2, 2) };
        card.Controls.Add(_tbl);
        Controls.Add(card); Controls.Add(bar);
    }

    public void Add(string dir, string ch, string text) { lock (_pending) _pending.Add((DateTime.Now, dir, ch, text)); }

    public void Flush()
    {
        (DateTime T, string Dir, string Ch, string Text)[] batch;
        lock (_pending) { batch = _pending.ToArray(); _pending.Clear(); }
        foreach (var (t, dir, ch, text) in batch)
        {
            var key = dir + "|" + ch;
            if (_dedup.Checked && dir is "PLC→GW" or "GW→Cloud" && _last.TryGetValue(key, out var prev) && prev == text) continue;
            _last[key] = text;
            var i = _tbl.Rows.Add(t.ToString("HH:mm:ss.fff"), dir, ch, text);
            _tbl.Rows[i].DefaultCellStyle.ForeColor = dir switch
            {
                "PLC→GW" => Theme.Green,
                "GW→PLC" => Color.FromArgb(255, 152, 48),
                "Cloud→GW" => Color.FromArgb(184, 119, 217),
                var x when x.StartsWith("GW→Cloud") => Theme.Accent,
                _ => Theme.Muted,
            };
        }
        while (_tbl.Rows.Count > 3000) _tbl.Rows.RemoveAt(0);
        if (batch.Length > 0 && _scroll.Checked && _tbl.Rows.Count > 0) _tbl.FirstDisplayedScrollingRowIndex = _tbl.Rows.Count - 1;
    }
}
