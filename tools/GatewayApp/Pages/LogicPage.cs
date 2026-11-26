using System.Text.Json;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Trang "Logic": chương trình logic đang chạy trên gateway này (bảng tiếng Việt do server dựng, cùng bảng chủ trạm thấy trên webapp)
/// và ĐỀ XUẤT của quản trị viên đang chờ duyệt — chủ trạm DUYỆT / TỪ CHỐI ngay tại gateway (cần mở khoá: mật khẩu gateway hoặc đăng nhập webapp),
/// hoặc trên webapp. Duyệt = gateway áp dụng chương trình rồi báo server. Xem docs/GATEWAY-LOGIC.md.
/// </summary>
sealed class LogicPage : UserControl
{
    readonly MainForm _app;
    readonly DataGridView _prop = new() { Dock = DockStyle.Fill };
    readonly DataGridView _cur = new() { Dock = DockStyle.Fill };
    readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Top, Height = 30, ForeColor = Theme.Muted, Font = Theme.Normal, Padding = new Padding(2, 6, 2, 0) };
    readonly Label _note = new() { AutoSize = false, Dock = DockStyle.Top, Height = 46, ForeColor = Theme.Yellow, Font = Theme.Semi, Padding = new Padding(2, 4, 2, 0) };
    readonly FlatButton _ok = new() { Caption = "✔ Duyệt và áp dụng", Width = 190, Primary = true, Enabled = false };
    readonly FlatButton _no = new() { Caption = "✖ Từ chối", Width = 120, Enabled = false };
    JsonElement? _pending;

    public LogicPage(MainForm app)
    {
        _app = app;
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        foreach (var g in new[] { _prop, _cur })
        {
            Skin.Grid(g);
            g.DefaultCellStyle.WrapMode = DataGridViewTriState.True; g.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
            // bảng chỉ để xem: không tô "dòng đang chọn" (đen) đè lên màu vàng của hàng thay đổi
            g.DefaultCellStyle.SelectionBackColor = g.DefaultCellStyle.BackColor; g.DefaultCellStyle.SelectionForeColor = g.DefaultCellStyle.ForeColor;
            g.AlternatingRowsDefaultCellStyle.SelectionBackColor = g.AlternatingRowsDefaultCellStyle.BackColor;
            foreach (var (n, t, w) in new[] { ("o", "Đầu ra", 170), ("u", "Khi điều khiển (luôn áp dụng)", 330), ("t", "Hẹn giờ", 170), ("f", "Khi mất mạng", 260) })
            { g.Columns.Add(n, t); g.Columns[n]!.Width = w; }
            g.Columns["f"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        }
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6), WrapContents = false };
        var reload = new FlatButton { Caption = "↻ Tải lại", Width = 110 };
        reload.Click += async (_, _) => await LoadAsync();
        _ok.Click += async (_, _) => await DecideAsync(true);
        _no.Click += async (_, _) => await DecideAsync(false);
        bar.Controls.AddRange(new Control[] { _ok, _no, reload });

        var propCard = new Card { Title = "Đề xuất đang chờ duyệt", Sub = "Hàng tô vàng = thay đổi so với bản đang chạy · duyệt ở đây hoặc trên webapp", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        propCard.Controls.Add(_prop); propCard.Controls.Add(_note);
        var curCard = new Card { Title = "Logic đang chạy trên gateway", Sub = "Chạy ngay trên gateway, kể cả khi mất mạng", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        curCard.Controls.Add(_cur);
        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, BackColor = Theme.Bg, SplitterWidth = 8 };
        split.Panel1.Controls.Add(propCard); split.Panel2.Controls.Add(curCard);
        Controls.Add(split); Controls.Add(_status); Controls.Add(bar);
        VisibleChanged += async (_, _) => { if (Visible) await LoadAsync(); };
    }

    static void Fill(DataGridView g, JsonElement rows, HashSet<string>? changed = null)
    {
        g.Rows.Clear();
        foreach (var r in rows.EnumerateArray())
        {
            var chEl = r.GetProperty("ch");
            var id = chEl.ValueKind == JsonValueKind.Number ? $"DO{chEl.GetInt32()}" : chEl.GetString() ?? "";
            var name = r.GetProperty("name").GetString() ?? id;
            var nl = Environment.NewLine;   // ô lưới chỉ xuống dòng với \r\n
            var i = g.Rows.Add(name == id ? name : $"{name}{nl}{id}",
                string.Join(nl, r.GetProperty("user").EnumerateArray().Select(x => x.GetString())),
                string.Join(nl, r.GetProperty("timer").EnumerateArray().Select(x => x.GetString())),
                r.GetProperty("offline").GetString());
            if (changed?.Contains(chEl.ToString()) == true)
            {
                var y = Color.FromArgb(70, 60, 20);
                g.Rows[i].DefaultCellStyle = new DataGridViewCellStyle { BackColor = y, ForeColor = Color.White, SelectionBackColor = y, SelectionForeColor = Color.White };
            }
        }
        g.ClearSelection();
    }

    public async Task LoadAsync()
    {
        _status.Text = "Đang tải từ server…"; _status.ForeColor = Theme.Muted;
        try
        {
            var r = await _app.LogicPendingAsync();
            _pending = r.TryGetProperty("pending", out var p) && p.ValueKind == JsonValueKind.Object ? p : null;
            if (r.TryGetProperty("current", out var c) && c.ValueKind == JsonValueKind.Object) Fill(_cur, c.GetProperty("rows")); else _cur.Rows.Clear();
            if (_pending is { } pe)
            {
                Fill(_prop, pe.GetProperty("rows"), pe.GetProperty("changed").EnumerateArray().Select(x => x.ToString()).ToHashSet());
                var note = pe.GetProperty("note").GetString();
                _note.Text = $"#{pe.GetProperty("id")} · {pe.GetProperty("by").GetString()} · {DateTimeOffset.FromUnixTimeMilliseconds(pe.GetProperty("createdAt").GetInt64()).LocalDateTime:dd/MM HH:mm}" + (string.IsNullOrEmpty(note) ? "" : $"\n{note}");
            }
            else { _prop.Rows.Clear(); _note.Text = "Không có đề xuất nào đang chờ."; }
            _ok.Enabled = _no.Enabled = _pending != null;
            _status.Text = $"Logic đang chạy: bản {_app.LogicRev}.";
        }
        catch (Exception e) { _status.Text = "Không tải được từ server: " + e.Message + " (cần đã đăng ký cloud và có mạng)"; _status.ForeColor = Theme.Red; }
    }

    /// <summary>Kết quả từng bước: GIỮ trên dòng trạng thái + ghi Nhật ký (thông báo nổi tự tắt sau vài giây, dễ lỡ).</summary>
    void Say(string t, bool err = false) { _status.Text = t; _status.ForeColor = err ? Theme.Red : Theme.Text; _app.LogicLog(t); }

    async Task DecideAsync(bool approve)
    {
        try { await DecideCoreAsync(approve); }
        catch (Exception e) { Say($"Lỗi khi {(approve ? "duyệt" : "từ chối")}: {e.GetType().Name}: {e.Message}", true); }
        finally { _ok.Enabled = _no.Enabled = _pending != null; }
    }

    async Task DecideCoreAsync(bool approve)
    {
        if (_pending is not { } pe) { Say("Không có đề xuất nào để duyệt."); return; }
        var id = pe.GetProperty("id").GetInt64();
        Say($"Bấm {(approve ? "Duyệt" : "Từ chối")} đề xuất #{id} — chờ xác nhận…");
        var q = approve ? $"Áp dụng logic mới (đề xuất #{id})?\n\nCác hàng tô vàng thay đổi cách gateway tự bật/tắt thiết bị (kể cả khi mất mạng). Áp dụng ngay, không khởi động lại."
                        : $"Từ chối đề xuất #{id}? Gateway giữ nguyên logic đang chạy.";
        if (MessageBox.Show(FindForm(), q, approve ? "Duyệt logic" : "Từ chối", MessageBoxButtons.OKCancel, approve ? MessageBoxIcon.Warning : MessageBoxIcon.Question) != DialogResult.OK)
        { Say("Đã huỷ — không thay đổi gì."); return; }
        _ok.Enabled = _no.Enabled = false;
        Say("Đang " + (approve ? "áp dụng" : "từ chối") + "…");
        var err = await _app.DecideLogicAsync(pe, approve);
        await LoadAsync();
        if (err != null) { Say(err, true); _app.Toast(err, error: true); }
        else { Say(approve ? $"✔ Đã áp dụng logic mới (bản {_app.LogicRev}) và báo server." : "Đã từ chối đề xuất."); _app.Toast(approve ? "Đã áp dụng logic mới." : "Đã từ chối đề xuất."); }
    }
}
