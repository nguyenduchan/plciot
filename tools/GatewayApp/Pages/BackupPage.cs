using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>Trang Sao lưu: tạo / xem / khôi phục / xuất-nhập gói sao lưu (xem BackupService). Mọi thao tác ghi đều đi qua MainForm (mở khoá + xác nhận).</summary>
sealed class BackupPage : UserControl
{
    readonly MainForm _app;
    readonly DataGridView _tbl = new() { Dock = DockStyle.Fill };
    readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Top, Height = 54, ForeColor = Theme.Text, Font = Theme.Normal, Padding = new Padding(2, 4, 2, 0) };
    readonly TextBox _extra = new() { Width = 380, Font = Theme.Normal };
    List<BackupInfo> _items = new();

    public BackupPage(MainForm app)
    {
        _app = app;
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);
        Skin.Grid(_tbl);
        _tbl.Columns.Add("t", "Thời gian"); _tbl.Columns.Add("k", "Loại"); _tbl.Columns.Add("v", "Phiên bản app"); _tbl.Columns.Add("s", "Dung lượng"); _tbl.Columns.Add("m", "Máy");
        _tbl.Columns[0].Width = 180; _tbl.Columns[1].Width = 130; _tbl.Columns[2].Width = 150; _tbl.Columns[3].Width = 110; _tbl.Columns[4].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
        _tbl.MultiSelect = false; _tbl.SelectionMode = DataGridViewSelectionMode.FullRowSelect;

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6), WrapContents = false };
        FlatButton Btn(string cap, int w, Func<Task> act, bool primary = false)
        {
            var b = new FlatButton { Caption = cap, Width = w, Primary = primary };
            b.Click += async (_, _) => { try { await act(); } catch (Exception e) { _app.Toast("Lỗi: " + e.Message, error: true); } Reload(); };
            return b;
        }
        bar.Controls.AddRange(new Control[]
        {
            Btn("💾 Sao lưu ngay", 150, async () => await _app.BackupNowAsync("manual", interactive: true), primary: true),
            Btn("↩ Khôi phục bản chọn", 190, async () => { if (Selected is { } s) await _app.RestoreAsync(s.Path); else _app.Toast("Chọn một bản trong danh sách.", error: true); }),
            Btn("📂 Nhập từ file…", 150, async () => { using var d = new OpenFileDialog { Filter = "Gói sao lưu (*.gwbackup)|*.gwbackup", Title = "Chọn gói sao lưu" }; if (d.ShowDialog(this) == DialogResult.OK) await _app.RestoreAsync(d.FileName); }),
            Btn("⬆ Xuất bản chọn…", 160, async () => { if (Selected is { } s) { using var d = new SaveFileDialog { FileName = s.Name, Filter = "Gói sao lưu (*.gwbackup)|*.gwbackup" }; if (d.ShowDialog(this) == DialogResult.OK) { File.Copy(s.Path, d.FileName, true); _app.Toast("Đã xuất " + d.FileName); } } await Task.CompletedTask; }),
            Btn("🔑 Xem khoá khôi phục", 190, async () => await _app.ShowRecoveryKeyAsync()),
        });

        var extraRow = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44, BackColor = Theme.Bg, Padding = new Padding(0, 6, 0, 4), WrapContents = false };
        extraRow.Controls.Add(new Label { Text = "Chép thêm bản sao sang thư mục (USB / ổ mạng):", AutoSize = true, ForeColor = Theme.Text, Font = Theme.Normal, Margin = new Padding(0, 8, 8, 0) });
        extraRow.Controls.Add(_extra);
        var browse = new FlatButton { Caption = "Chọn…", Width = 90 };
        browse.Click += (_, _) => { using var d = new FolderBrowserDialog { Description = "Thư mục chép thêm bản sao lưu (nên là ổ khác / USB / ổ mạng)" }; if (d.ShowDialog(this) == DialogResult.OK) { _extra.Text = d.SelectedPath; SaveExtra(); } };
        _extra.Leave += (_, _) => SaveExtra();
        extraRow.Controls.Add(browse);

        var card = new Card { Title = "Bản sao lưu", Sub = "Tự động mỗi ngày · trước mỗi lần cập nhật · trước khi khôi phục", Dock = DockStyle.Fill, Padding = new Padding(2, 40, 2, 2) };
        card.Controls.Add(_tbl); card.Controls.Add(_status);
        Controls.Add(card); Controls.Add(extraRow); Controls.Add(bar);
        VisibleChanged += (_, _) => { if (Visible) Reload(); };
    }

    BackupInfo? Selected => _tbl.CurrentRow is { Index: >= 0 } r && r.Index < _items.Count ? _items[r.Index] : null;

    void SaveExtra() { try { _app.Backup.ExtraDir = _extra.Text.Trim(); } catch (IOException) { } }

    static string Kind(string r) => r switch { "auto" => "Tự động", "manual" => "Thủ công", "pre-update" => "Trước cập nhật", "pre-restore" => "Trước khôi phục", _ => r };

    public void Reload()
    {
        if (IsDisposed || _tbl.IsDisposed) return;
        var b = _app.Backup;
        _items = b.List();
        _tbl.Rows.Clear();
        foreach (var i in _items) _tbl.Rows.Add(i.At.ToString("dd/MM/yyyy HH:mm:ss"), Kind(i.Reason), i.AppVersion.Length > 0 ? i.AppVersion : "—", $"{i.Size / 1024.0:0.#} KB", i.MachineId);
        if (!_extra.Focused) _extra.Text = b.ExtraDir;
        var last = _items.FirstOrDefault();
        _status.Text = (b.HasKey ? "Khoá khôi phục: đã có trên máy này. " : "Chưa có khoá khôi phục — sẽ tạo khi sao lưu lần đầu (hãy cất khoá ngoài máy!). ")
            + (last == null ? "Chưa có bản sao lưu nào." : $"Bản gần nhất: {last.At:dd/MM/yyyy HH:mm} ({Kind(last.Reason)}).")
            + (b.LastExtraError is { } e ? $"\nChép sang thư mục thứ hai lỗi: {e}" : "");
        _status.ForeColor = last != null && DateTime.Now - last.At < TimeSpan.FromDays(2) ? Theme.Text : Theme.Yellow;
    }
}
