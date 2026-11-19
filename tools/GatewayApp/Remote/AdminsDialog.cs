using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// PC quản trị của board Waveshare: PC đang dùng và PC đang CHỜ (ghép bằng BOOT khi board đã có PC quản trị).
/// PC quản trị cũ giữ quyền: Đồng ý (kích hoạt ngay) hoặc Từ chối; không ai từ chối thì PC chờ tự kích hoạt sau 24 giờ.
/// </summary>
sealed class AdminsDialog : Form
{
    readonly RemoteClient _client;
    readonly ListView _list = new() { View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, Dock = DockStyle.Fill, BackColor = Theme.Panel, ForeColor = Theme.Text, BorderStyle = BorderStyle.None };
    readonly Label _msg = new() { AutoSize = false, Dock = DockStyle.Bottom, Height = 40, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(14, 4, 14, 0) };
    readonly FlatButton _approve = new() { Caption = "Đồng ý", Primary = true, Width = 110 }, _reject = new() { Caption = "Từ chối / Gỡ", Danger = true, Width = 130 };

    AdminsDialog(RemoteClient client)
    {
        _client = client;
        Text = "PC quản trị board"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(620, 360);
        var info = new Label { Dock = DockStyle.Top, Height = 54, ForeColor = Theme.Muted, Padding = new Padding(14, 10, 14, 0),
            Text = "PC mới ghép bằng nút BOOT khi board đã có PC quản trị phải chờ: bấm Đồng ý để kích hoạt ngay, Từ chối để chặn. Không ai từ chối thì PC đó tự được kích hoạt sau 24 giờ." };
        _list.Columns.Add("PC", 200); _list.Columns.Add("Ghép bằng", 100); _list.Columns.Add("Trạng thái", 260);
        var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14, 4, 14, 8), BackColor = Theme.Bg }; host.Controls.Add(_list);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg };
        var close = new FlatButton { Caption = "Đóng", Width = 90 }; close.Click += (_, _) => Close();
        _approve.Click += async (_, _) => await ActAsync("approve");
        _reject.Click += async (_, _) => await ActAsync(Selected()?.Active == true ? "remove" : "reject");
        bar.Controls.AddRange(new Control[] { _approve, _reject, close });
        Controls.Add(host); Controls.Add(_msg); Controls.Add(bar); Controls.Add(info);
        _list.SelectedIndexChanged += (_, _) => { var a = Selected(); _approve.Enabled = a is { Active: false }; _reject.Enabled = a is { Self: false }; };
        Shown += async (_, _) => await ReloadAsync();
    }

    ApiAdmin? Selected() => _list.SelectedItems.Count > 0 ? (ApiAdmin)_list.SelectedItems[0].Tag! : null;

    async Task ReloadAsync()
    {
        try
        {
            var all = await _client.AdminsAsync();
            _list.Items.Clear();
            foreach (var a in all)
            {
                var st = a.Active ? "Đang dùng" : $"Đang chờ — tự kích hoạt sau {(a.RemainMin >= 60 ? $"{a.RemainMin / 60} giờ {a.RemainMin % 60} phút" : $"{a.RemainMin} phút")}";
                var it = new ListViewItem(new[] { a.Name + (a.Self ? " (PC này)" : ""), a.How, st }) { Tag = a };
                if (!a.Active) it.ForeColor = Theme.Yellow;
                _list.Items.Add(it);
            }
            _approve.Enabled = _reject.Enabled = false;
            _msg.ForeColor = Theme.Muted; _msg.Text = $"{all.Count(a => a.Active)} PC đang dùng, {all.Count(a => !a.Active)} PC đang chờ.";
        }
        catch (Exception e) { _msg.ForeColor = Theme.Red; _msg.Text = RemoteClient.Explain(e); }
    }

    async Task ActAsync(string action)
    {
        var a = Selected(); if (a == null) return;
        if (action != "approve" && !Ask.Yes(this, action == "reject" ? $"Từ chối PC \"{a.Name}\"? PC đó phải nhấn BOOT ghép lại." : $"Gỡ PC \"{a.Name}\" khỏi board? PC đó không vào được nữa.", "PC quản trị")) return;
        try
        {
            var r = await _client.AdminActionAsync(a.Id, action);
            if (!r.Ok) { _msg.ForeColor = Theme.Red; _msg.Text = r.Err ?? "Lỗi."; return; }
            await ReloadAsync();
        }
        catch (Exception e) { _msg.ForeColor = Theme.Red; _msg.Text = RemoteClient.Explain(e); }
    }

    public static void Run(IWin32Window owner, RemoteClient client) { using var d = new AdminsDialog(client); d.ShowDialog(owner); }
}
