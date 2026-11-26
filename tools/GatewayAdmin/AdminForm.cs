using System.Text.Json;
using GatewayApp;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// Danh sách gateway trên server → mở cửa sổ thiết lập (đúng các trang của GatewayApp) qua cloud.
/// Chỉ gateway mà chủ đã bật "Cho phép hỗ trợ từ xa" trên webapp mới mở được.
/// </summary>
sealed class AdminForm : Form
{
    readonly AdminKey _key;
    readonly AdminApi _api;
    readonly DataGridView _tbl = new() { Dock = DockStyle.Fill };
    readonly Label _status = new() { Dock = DockStyle.Top, Height = 46, ForeColor = Theme.Muted, Font = Theme.Normal, Padding = new Padding(4, 6, 4, 0) };
    List<GatewayRow> _rows = new();

    public AdminForm(AdminKey key, string server)
    {
        _key = key; _api = new AdminApi(server, key);
        Text = "GatewayAdmin — cài đặt gateway từ xa";
        Width = 1150; Height = 640; StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal;

        Skin.Grid(_tbl);
        foreach (var (n, t, w) in new[] { ("gw", "Gateway (site/device)", 230), ("own", "Chủ", 150), ("kind", "Loại", 110), ("ver", "Phiên bản", 120), ("seen", "Lần cuối thấy", 150), ("ok", "Cho phép từ xa", 140) })
        { _tbl.Columns.Add(n, t); _tbl.Columns[n]!.Width = w; }
        _tbl.Columns["ok"]!.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _tbl.MultiSelect = false; _tbl.SelectionMode = DataGridViewSelectionMode.FullRowSelect; _tbl.ReadOnly = true;
        _tbl.CellDoubleClick += async (_, e) => { if (e.RowIndex >= 0) await OpenAsync(_rows[e.RowIndex]); };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 50, BackColor = Theme.Bg, Padding = new Padding(8, 6, 8, 4), WrapContents = false };
        FlatButton Btn(string cap, int w, Func<Task> act, bool primary = false)
        {
            var b = new FlatButton { Caption = cap, Width = w, Primary = primary };
            b.Click += async (_, _) => { try { await act(); } catch (Exception e) { Status(AdminApi.Explain(e), true); } };
            return b;
        }
        bar.Controls.Add(Btn("Mở cài đặt", 150, async () => { if (_tbl.CurrentRow is { Index: >= 0 } r && r.Index < _rows.Count) await OpenAsync(_rows[r.Index]); }, primary: true));
        bar.Controls.Add(Btn("📝 Logic", 120, () =>
        {
            if (_tbl.CurrentRow is { Index: >= 0 } r && r.Index < _rows.Count)
            {
                new LogicForm(_api, _rows[r.Index]).Show(this);   // board (doN) và gateway PC (đầu ra theo field)
            }
            return Task.CompletedTask;
        }));
        bar.Controls.Add(Btn("↻ Tải lại", 110, LoadAsync));
        bar.Controls.Add(Btn("🔑 Khoá máy này", 160, () => { ShowKey(); return Task.CompletedTask; }));
        bar.Controls.Add(new Label { Text = $"Server: {_api.Server} · máy {_key.KeyId}", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(16, 12, 0, 0) });

        var card = new Card { Title = "Gateway trên server", Sub = "Đúp chuột để mở · chỉ gateway chủ đã cho phép mới mở được", Dock = DockStyle.Fill, Padding = new Padding(6, 44, 6, 6) };
        card.Controls.Add(_tbl);
        Controls.Add(card); Controls.Add(_status); Controls.Add(bar);
        Shown += async (_, _) => await LoadAsync();
    }

    void Status(string text, bool error = false) { _status.Text = text; _status.ForeColor = error ? Theme.Red : Theme.Muted; }

    async Task LoadAsync()
    {
        Status("Đang tải danh sách gateway…");
        try
        {
            _rows = await _api.GatewaysAsync();
            _tbl.Rows.Clear();
            foreach (var g in _rows)
                _tbl.Rows.Add($"{g.Site}/{g.Device}", g.Owner ?? "—", g.Kind == "mcu" ? "Waveshare" : "Gateway PC", g.Version ?? "—",
                    g.LastSeen is { } t ? DateTimeOffset.FromUnixTimeMilliseconds(t).LocalDateTime.ToString("dd/MM HH:mm:ss") : "—", g.Allowed ? "✓ cho phép" : "✗ chưa cho phép");
            Status($"{_rows.Count} gateway · {_rows.Count(r => r.Allowed)} đã cho phép hỗ trợ từ xa.");
        }
        catch (AdminApiException e) when (e.Code == "radmin_unknown_key") { Status(AdminApi.Explain(e), true); ShowKey(); }
    }

    void ShowKey()
    {
        var cmd = _key.RegisterCommand;
        try { Clipboard.SetText(cmd); } catch (Exception) { /* không có clipboard: vẫn hiện để chép tay */ }
        MessageBox.Show(this, "Đăng ký máy này trên server (chạy trên VPS qua SSH — đã chép vào clipboard):\n\n" + cmd +
            "\n\nChỉ người có SSH vào VPS mới thêm được máy cài đặt từ xa.", "Khoá máy GatewayAdmin", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    /// <summary>Mở cửa sổ thiết lập gateway qua cloud — đúng các trang (Tổng quan, Thiết bị, Khi mất mạng, Cloud, Nhật ký) như qua LAN.</summary>
    internal async Task<Form?> OpenAsync(GatewayRow g, bool show = true)
    {
        if (!g.Allowed) { Status($"{g.Site}/{g.Device}: chủ gateway chưa bật \"Cho phép hỗ trợ từ xa\" trên webapp.", true); return null; }
        Status($"Đang mở {g.Site}/{g.Device} qua cloud…");
        var c = new RemoteClient(new RelayHandler(_api, g.Site, g.Device), $"{g.Site}/{g.Device}");
        try
        {
            var first = await c.ConfigAsync();
            var f = RemoteForm.OpenRelay(c, new ApiHello { Kind = g.Kind, Name = $"{g.Site}/{g.Device}", Version = g.Version ?? "" }, first);
            if (show) f.Show(this);
            Status($"Đã mở {g.Site}/{g.Device}.");
            return f;
        }
        catch (Exception e) { c.Dispose(); Status($"{g.Site}/{g.Device}: {RemoteClient.Explain(e)}", true); return null; }
    }

    internal AdminApi Api => _api;
    internal List<GatewayRow> Rows => _rows;
    internal Task ReloadForTestAsync() => LoadAsync();
}
