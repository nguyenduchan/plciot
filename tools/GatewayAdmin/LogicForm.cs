using System.Text.Json;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// Soạn CHƯƠNG TRÌNH LOGIC của một gateway bằng TEXT (cú pháp: cloud/app/src/logicDsl.js, docs/GATEWAY-LOGIC.md) — kiểu lập trình viên:
/// gõ → F5 kiểm (server dịch, hiện bảng tiếng Việt đúng như chủ trạm sẽ thấy) → Ctrl+Enter gửi ĐỀ XUẤT → chủ trạm duyệt trên webapp.
/// Text copy được sang gateway khác (tên field phải khớp cấu hình của gateway đó — board kiểm lại khi áp dụng).
/// </summary>
sealed class LogicForm : Form
{
    const string Help =
        "Mỗi dòng một DO, mệnh đề cách nhau bằng |, # = chú thích. Thời gian: 30s 5m 2h.\r\n" +
        "  tz 7\r\n" +
        "  do1: need di3=1, hold | block do2 | maxon 30m | offline 2m: level bon.muc on<=20 off>=90\r\n" +
        "  do3: timer 18:00-05:30 t2-t6 | offline 5m: schedule 18:00-05:30\r\n" +
        "need <đk>[, …][, hold]   đk: di3=1 · di3=0 · tb.field>=5 · tb.field<=5 [age 60s]   (hold = mất đk thì tự tắt)\r\n" +
        "block do2[, do5] · maxon 30m · timer 06:00-06:30 [t2-t6|t2,t4|t7-cn] · timer on 06:00 · timer off 22:00\r\n" +
        "offline [chờ]: hold | off | on | schedule 18:00-05:30 | follow di2 [invert] | level tb.field on<=20 off>=90 [age 30s] | cycle on 10m off 20m\r\n" +
        "Gateway PC: đầu ra viết theo field ghi được, điều kiện theo field (không có di):\r\n" +
        "  pump1.run: need tank1.level_pct>=10, pump1.ok=1, hold | block pump1.boost | maxon 30m | offline 2m: level tank1.level_pct on<=20 off>=90\r\n" +
        "  valve1.open: offline: follow pump1.run [invert]\r\n" +
        "Đề xuất không có timer cho đầu ra nào thì GIỮ hẹn giờ chủ trạm đã cài ở đầu ra đó.";

    readonly AdminApi _api;
    readonly GatewayRow _gw;
    readonly TextBox _code = new() { Multiline = true, ScrollBars = ScrollBars.Both, WordWrap = false, AcceptsTab = true, Dock = DockStyle.Fill, Font = new Font("Consolas", 11f) };
    readonly TextBox _note = new() { Dock = DockStyle.Fill, PlaceholderText = "Ghi chú cho chủ trạm (vd: theo yêu cầu ngày 26/11 — bơm tự tắt khi phao cạn)" };
    readonly DataGridView _tbl = new() { Dock = DockStyle.Fill };
    readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 52, ForeColor = Theme.Muted, Padding = new Padding(6, 4, 6, 0) };
    readonly Label _pending = new() { Dock = DockStyle.Top, Height = 26, ForeColor = Theme.Yellow, Padding = new Padding(6, 4, 6, 0) };
    string _currentText = "";

    public LogicForm(AdminApi api, GatewayRow gw)
    {
        _api = api; _gw = gw;
        Text = $"Logic — {gw.Site}/{gw.Device}";
        Width = 1400; Height = 860; MinimumSize = new Size(1000, 600); StartPosition = FormStartPosition.CenterParent; KeyPreview = true;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;
        Skin.Input(_code); Skin.Input(_note); _code.Font = new Font("Consolas", 11f);
        Skin.Grid(_tbl);
        _tbl.DefaultCellStyle.WrapMode = DataGridViewTriState.True;
        _tbl.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
        foreach (var (n, t, w) in new[] { ("do", "Đầu ra", 130), ("user", "Khi điều khiển (luôn áp dụng)", 300), ("timer", "Hẹn giờ", 150), ("off", "Khi mất mạng", 260) })
        { _tbl.Columns.Add(n, t); _tbl.Columns[n]!.Width = w; }
        _tbl.Columns["off"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Theme.Bg, Padding = new Padding(8, 6, 8, 4), WrapContents = false };
        FlatButton Btn(string cap, int w, Func<Task> act, bool primary = false)
        {
            var b = new FlatButton { Caption = cap, Width = w, Primary = primary };
            b.Click += async (_, _) => await Guard(act);
            return b;
        }
        bar.Controls.Add(Btn("Kiểm tra (F5)", 140, CheckAsync));
        bar.Controls.Add(Btn("Gửi đề xuất (Ctrl+Enter)", 220, ProposeAsync, primary: true));
        bar.Controls.Add(Btn("↺ Bản đang chạy", 150, () => { _code.Text = _currentText; return CheckAsync(); }));
        bar.Controls.Add(Btn("⧉ Chép text", 120, () => { try { Clipboard.SetText(_code.Text); Status("Đã chép — dán vào GatewayAdmin của gateway khác."); } catch (Exception) { } return Task.CompletedTask; }));
        bar.Controls.Add(Btn("↻ Tải lại", 110, LoadAsync));

        var help = new Label { Text = Help, Dock = DockStyle.Bottom, Height = 200, Font = new Font("Consolas", 9f), ForeColor = Theme.Muted, BackColor = Theme.Panel, Padding = new Padding(6) };
        var codeCard = new Card { Title = "Chương trình (text)", Sub = "Một chương trình / gateway · copy được sang gateway khác", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        codeCard.Controls.Add(_code); codeCard.Controls.Add(help);
        var noteBox = new Panel { Dock = DockStyle.Bottom, Height = 34, Padding = new Padding(0, 4, 0, 0) };
        noteBox.Controls.Add(_note);
        codeCard.Controls.Add(noteBox);
        var prevCard = new Card { Title = "Chủ trạm sẽ thấy", Sub = "Bảng duyệt trên webapp · hàng vàng = thay đổi so với bản đang chạy", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        prevCard.Controls.Add(_tbl); prevCard.Controls.Add(_pending);

        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, BackColor = Theme.Bg, SplitterWidth = 6 };
        split.Panel1.Controls.Add(codeCard); split.Panel2.Controls.Add(prevCard);
        Controls.Add(split); Controls.Add(_status); Controls.Add(bar);
        Shown += async (_, _) => { split.SplitterDistance = Width / 2 - 40; await Guard(LoadAsync); };
        KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.F5) { e.Handled = true; await Guard(CheckAsync); }
            else if (e.KeyCode == Keys.Enter && e.Control) { e.Handled = true; e.SuppressKeyPress = true; await Guard(ProposeAsync); }
        };
    }

    async Task Guard(Func<Task> act)
    {
        try { await act(); }
        catch (Exception e) { Status(AdminApi.Explain(e), true); }
    }

    void Status(string t, bool error = false) { _status.Text = t; _status.ForeColor = error ? Theme.Red : Theme.Muted; }

    async Task LoadAsync()
    {
        Status("Đang tải chương trình đang chạy…");
        using var d = JsonDocument.Parse(await _api.LogicAsync(_gw.Site, _gw.Device));
        var r = d.RootElement;
        if (r.TryGetProperty("current", out var cur) && cur.ValueKind == JsonValueKind.Object)
        {
            _currentText = cur.GetProperty("text").GetString() ?? "";
            if (_code.Text.Trim().Length == 0) _code.Text = _currentText.Replace("\n", "\r\n");
            Fill(cur.GetProperty("rows"), Array.Empty<string>());
            Status($"Bản đang chạy: rev {cur.GetProperty("rev")}.");
        }
        else { _currentText = "tz 7\n"; if (_code.Text.Trim().Length == 0) _code.Text = "tz 7\r\n"; Status("Gateway chưa báo chương trình (firmware cũ hoặc chưa nối cloud) — vẫn soạn và gửi đề xuất được.", true); }
        _pending.Text = "";
        foreach (var p in r.GetProperty("proposals").EnumerateArray())
        {
            var st = p.GetProperty("status").GetString();
            if (st == "pending") { _pending.Text = $"⏳ Đề xuất #{p.GetProperty("id")} đang chờ chủ trạm duyệt (gửi mới sẽ thay nó)."; break; }
            _pending.Text = $"Đề xuất gần nhất #{p.GetProperty("id")}: {st} {p.GetProperty("result").GetString()}";
            break;
        }
    }

    void Fill(JsonElement rows, IEnumerable<string> changed)
    {
        var ch = changed.ToHashSet();
        _tbl.Rows.Clear();
        foreach (var r in rows.EnumerateArray())
        {
            var chEl = r.GetProperty("ch");   // số DO (board) hoặc "thiết bị.field" (gateway PC)
            var id = chEl.ValueKind == JsonValueKind.Number ? $"DO{chEl.GetInt32()}" : chEl.GetString() ?? "";
            var name = r.GetProperty("name").GetString() ?? id;
            int i = _tbl.Rows.Add(name == id ? name : $"{name}\n{id}",
                string.Join("\n", r.GetProperty("user").EnumerateArray().Select(x => x.GetString())),
                string.Join("\n", r.GetProperty("timer").EnumerateArray().Select(x => x.GetString())),
                r.GetProperty("offline").GetString());
            if (ch.Contains(chEl.ToString())) _tbl.Rows[i].DefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(70, 60, 20), ForeColor = Color.White };
        }
    }

    async Task<bool> TryCheckAsync()
    {
        try
        {
            using var d = JsonDocument.Parse(await _api.LogicCheckAsync(_gw.Site, _gw.Device, _code.Text));
            var changed = d.RootElement.GetProperty("changed").EnumerateArray().Select(x => x.ToString()).ToArray();
            Fill(d.RootElement.GetProperty("rows"), changed);
            Status(changed.Length == 0 ? "✓ Cú pháp đúng — không khác bản đang chạy." : $"✓ Cú pháp đúng — thay đổi: {string.Join(", ", changed.Select(c => int.TryParse(c, out _) ? "DO" + c : c))}.");
            return true;
        }
        catch (AdminApiException e) when (e.Code == "logic_syntax")
        {
            Status("✗ " + e.Detail, true);
            if (e.Detail is { } m && m.StartsWith("Dòng ") && int.TryParse(m[5..m.IndexOf(':')], out var line)) SelectLine(line);
            return false;
        }
    }

    Task CheckAsync() => TryCheckAsync();

    void SelectLine(int line)
    {
        var lines = _code.Lines;
        if (line < 1 || line > lines.Length) return;
        int start = lines.Take(line - 1).Sum(l => l.Length + 2);
        _code.Focus(); _code.Select(start, lines[line - 1].Length); _code.ScrollToCaret();
    }

    async Task ProposeAsync()
    {
        if (!await TryCheckAsync()) return;
        if (MessageBox.Show(this, $"Gửi đề xuất logic cho chủ trạm {_gw.Site}/{_gw.Device}?\n\nChủ trạm nhận thông báo, xem bảng bên phải và bấm duyệt trên webapp — chỉ khi đó gateway mới đổi.",
                "Gửi đề xuất", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        using var d = JsonDocument.Parse(await _api.LogicProposeAsync(_gw.Site, _gw.Device, _code.Text, _note.Text));
        Status($"✓ Đã gửi đề xuất #{d.RootElement.GetProperty("id")} — chờ chủ trạm duyệt trên webapp.");
        await LoadAsync();
    }
}
