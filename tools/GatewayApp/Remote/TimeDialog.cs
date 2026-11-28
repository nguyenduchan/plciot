using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Giờ của board Waveshare khi chạy OFFLINE (GET/PUT /api/time): giờ board và giờ PC chạy từng giây, độ lệch, nguồn giờ, RTC, lần đặt
/// gần nhất; nút "Đồng bộ giờ từ PC này". Giờ server luôn ưu tiên: board đang dùng giờ server thì phải xác nhận mới ghi đè.
/// Không có giờ tin được → mọi hẹn giờ trên board TẮT (an toàn), nên board offline mất nguồn nuôi RTC cần đặt giờ ở đây.
/// </summary>
sealed class TimeDialog : Form
{
    readonly RemoteClient _client;
    ApiTime _t;
    long _fetchedTick;   // Environment.TickCount64 lúc đọc giờ board (giờ board chạy tiếp theo đồng hồ PC giữa hai lần đọc)
    readonly Label _board = new() { AutoSize = true, Font = new Font(Theme.Big.FontFamily, 22f, FontStyle.Bold), ForeColor = Theme.Text, UseMnemonic = false };
    readonly Label _pc = new() { AutoSize = true, ForeColor = Theme.Muted, UseMnemonic = false };
    readonly Label _drift = new() { AutoSize = true, Font = Theme.Semi, UseMnemonic = false };
    readonly Label _info = new() { AutoSize = false, Height = 150, Dock = DockStyle.Top, ForeColor = Theme.Muted, Padding = new Padding(18, 4, 18, 0), UseMnemonic = false };
    readonly Label _msg = new() { AutoSize = false, Dock = DockStyle.Bottom, Height = 44, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(18, 4, 18, 0), UseMnemonic = false };
    readonly FlatButton _sync = new() { Caption = "Đồng bộ giờ từ PC này", Primary = true, Width = 210 };
    readonly System.Windows.Forms.Timer _tick = new() { Interval = 500 };

    TimeDialog(RemoteClient client, ApiTime t)
    {
        _client = client; _t = t; _fetchedTick = Environment.TickCount64;
        Text = "Giờ của board Waveshare"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(500, 400);
        var top = new Panel { Dock = DockStyle.Top, Height = 120, Padding = new Padding(18, 14, 18, 0), BackColor = Theme.Bg };
        _board.Location = new Point(18, 12); _pc.Location = new Point(20, 58); _drift.Location = new Point(20, 84);
        top.Controls.AddRange(new Control[] { _board, _pc, _drift });
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(12, 6, 12, 0), BackColor = Theme.Bg };
        var refresh = new FlatButton { Caption = "Làm mới", Width = 100 };
        var close = new FlatButton { Caption = "Đóng", Width = 90 };
        refresh.Click += async (_, _) => await ReloadAsync();
        close.Click += (_, _) => Close();
        _sync.Click += async (_, _) => await SyncAsync();
        bar.Controls.AddRange(new Control[] { _sync, refresh, close });
        Controls.Add(_info); Controls.Add(top); Controls.Add(_msg); Controls.Add(bar);
        _tick.Tick += (_, _) => Render();
        Shown += (_, _) => { Render(); _tick.Start(); };
        FormClosed += (_, _) => _tick.Dispose();
    }

    static string Local(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("HH:mm:ss  dd/MM/yyyy");
    static string SourceText(string s) => s switch
    {
        "ntp" => "Giờ server (qua internet) — chuẩn nhất",
        "pc" => "PC quản trị đặt qua mạng LAN",
        "rtc" => "Đồng hồ RTC trên board (giữ giờ khi mất điện)",
        _ => "CHƯA CÓ GIỜ — mọi hẹn giờ đang TẮT",
    };

    void Render()
    {
        var pcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long boardMs = _t.NowMs > 0 ? _t.NowMs + (Environment.TickCount64 - _fetchedTick) : 0;
        _board.Text = boardMs > 0 ? Local(boardMs) : "— chưa có giờ —";
        _board.ForeColor = _t.Trusted ? Theme.Text : Theme.Red;
        _pc.Text = $"Giờ PC này:  {Local(pcMs)}  ({TimeZoneInfo.Local.DisplayName})";
        if (boardMs > 0)
        {
            var d = (_t.NowMs - (pcMs - (Environment.TickCount64 - _fetchedTick))) / 1000.0;   // lệch lúc đọc (không trôi theo bộ đếm)
            _drift.Text = Math.Abs(d) < 1 ? "Khớp giờ PC (lệch < 1 giây)" : $"Board {(d > 0 ? "nhanh" : "chậm")} hơn PC {Math.Abs(d):0.#} giây";
            _drift.ForeColor = Math.Abs(d) <= BoardTimeSync.MaxDriftMs / 1000.0 ? Theme.Green : Theme.Yellow;
        }
        else { _drift.Text = "Board chưa có giờ — bấm Đồng bộ giờ từ PC này"; _drift.ForeColor = Theme.Red; }
        var rtc = !_t.RtcFound ? "không thấy chip RTC" : !_t.RtcValid ? "chưa có giờ hợp lệ (mất nguồn nuôi / chưa từng đặt)"
            : _t.RtcDriftMs is long rd ? $"đang chạy, lệch giờ hệ thống {rd / 1000.0:+0.#;-0.#;0} s" : "đang chạy";
        var info = $"Nguồn giờ:  {SourceText(_t.Source)}\nRTC trên board:  {rtc}\n";
        info += _t.LastSyncMs is long ls ? $"Đặt giờ gần nhất:  {Local(ls)} — {_t.LastSyncBy}\n" : "Đặt giờ gần nhất:  chưa có (từ lúc khởi động)\n";
        info += $"Board chạy liên tục:  {TimeSpan.FromSeconds(_t.UpSec):d\\.hh\\:mm\\:ss}\n\n";
        info += "Có internet: board tự lấy giờ từ server. Mất internet: board chạy theo RTC. Board làm slave của gateway PC thì gateway PC tự giữ giờ cho board.";
        if (_info.Text != info) _info.Text = info;
    }

    async Task ReloadAsync()
    {
        try { _t = await _client.TimeAsync(); _fetchedTick = Environment.TickCount64; _msg.ForeColor = Theme.Muted; _msg.Text = ""; Render(); }
        catch (Exception e) { _msg.ForeColor = Theme.Red; _msg.Text = RemoteClient.Explain(e); }
    }

    async Task SyncAsync()
    {
        var force = false;
        if (_t.Source == "ntp")
        {
            if (!Ask.Yes(this, "Board đang dùng giờ SERVER (qua internet) — chuẩn hơn giờ PC.\nChỉ ghi đè khi chắc chắn giờ server sai.\n\nVẫn đặt theo giờ PC này?", "Ghi đè giờ server")) return;
            force = true;
        }
        _sync.Enabled = false; _msg.ForeColor = Theme.Muted; _msg.Text = "Đang đặt giờ…";
        try
        {
            _t = await _client.PutTimeAsync(force); _fetchedTick = Environment.TickCount64;
            _msg.ForeColor = Theme.Green; _msg.Text = "Đã đặt giờ board theo PC này (ghi cả RTC).";
            Render();
        }
        catch (Exception e) { _msg.ForeColor = Theme.Red; _msg.Text = RemoteClient.Explain(e); }
        finally { if (!IsDisposed) _sync.Enabled = true; }
    }

    public static async Task RunAsync(IWin32Window owner, RemoteClient client)
    {
        ApiTime t;
        try { t = await client.TimeAsync(); }
        catch (RemoteException e) when (e.Code == "not_found") { MessageBox.Show(owner, "Firmware board chưa hỗ trợ quản lý giờ — cập nhật firmware (≥ mcu-0.4.26).", "Giờ của board", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
        catch (Exception e) { MessageBox.Show(owner, RemoteClient.Explain(e), "Giờ của board", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        using var d = new TimeDialog(client, t);
        d.ShowDialog(owner);
    }
}
