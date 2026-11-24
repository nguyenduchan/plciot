using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Cập nhật firmware board Waveshare qua LAN (POST /api/ota). Chọn file firmware.bin (PlatformIO: gateway-mcu\.pio\build\...\firmware.bin) →
/// gửi qua HTTPS đã ghim khoá → board kiểm SHA-256, đổi phân vùng khởi động và tự khởi động lại. Hỏng giữa chừng thì board giữ bản cũ.
/// </summary>
sealed class FirmwareDialog : Form
{
    readonly RemoteClient _client;
    readonly TextBox _path = new() { Dock = DockStyle.Fill, ReadOnly = true };
    readonly ProgressBar _bar = new() { Dock = DockStyle.Top, Height = 14, Minimum = 0, Maximum = 1000 };
    readonly Label _msg = new() { Dock = DockStyle.Fill, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(14, 8, 14, 0), UseMnemonic = false };
    readonly FlatButton _pick = new() { Caption = "Chọn file…", Width = 110 }, _go = new() { Caption = "Cập nhật", Primary = true, Width = 120 }, _close = new() { Caption = "Đóng", Width = 90 };
    byte[]? _fw;
    bool _busy;
    /// <summary>true = đã nạp xong, board đang khởi động lại (cửa sổ cài đặt phải nối lại).</summary>
    public bool Updated { get; private set; }

    FirmwareDialog(RemoteClient client, string currentVersion)
    {
        _client = client;
        Text = "Cập nhật firmware board"; StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false;
        BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(560, 250);
        var info = new Label { Dock = DockStyle.Top, Height = 58, ForeColor = Theme.Muted, Padding = new Padding(14, 10, 14, 0), UseMnemonic = false,
            Text = $"Phiên bản đang chạy: {(currentVersion.Length > 0 ? currentVersion : "không rõ")}. Chọn file firmware.bin đã build (gateway-mcu\\.pio\\build\\…). " +
                   "Board kiểm SHA-256 rồi tự khởi động lại; lỗi giữa chừng thì giữ nguyên bản cũ." };
        var row = new TableLayoutPanel { Dock = DockStyle.Top, Height = 40, ColumnCount = 2, Padding = new Padding(14, 6, 14, 0), BackColor = Theme.Bg };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
        row.Controls.Add(_path); row.Controls.Add(_pick);
        var barHost = new Panel { Dock = DockStyle.Top, Height = 28, Padding = new Padding(14, 8, 14, 0), BackColor = Theme.Bg }; barHost.Controls.Add(_bar);
        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(10, 6, 10, 0), BackColor = Theme.Bg, FlowDirection = FlowDirection.RightToLeft };
        bar.Controls.AddRange(new Control[] { _close, _go });
        Controls.Add(_msg); Controls.Add(bar); Controls.Add(barHost); Controls.Add(row); Controls.Add(info);
        _go.Enabled = false;
        _pick.Click += (_, _) => Pick();
        _go.Click += async (_, _) => await GoAsync();
        _close.Click += (_, _) => { if (!_busy) { DialogResult = Updated ? DialogResult.OK : DialogResult.Cancel; Close(); } };
        FormClosing += (_, e) => { if (_busy) e.Cancel = true; };
        var guess = FindBuilt(); if (guess != null) Load(guess);
    }

    /// <summary>Tìm firmware vừa build cạnh mã nguồn (chạy từ thư mục dự án).</summary>
    static string? FindBuilt()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var pio = Path.Combine(d.FullName, "gateway-mcu", ".pio", "build");
            if (!Directory.Exists(pio)) continue;
            return Directory.GetFiles(pio, "firmware.bin", SearchOption.AllDirectories).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
        }
        return null;
    }

    void Pick()
    {
        using var o = new OpenFileDialog { Title = "Chọn firmware.bin", Filter = "Firmware (*.bin)|*.bin", CheckFileExists = true };
        if (o.ShowDialog(this) == DialogResult.OK) Load(o.FileName);
    }

    void Load(string file)
    {
        _fw = null; _go.Enabled = false; _path.Text = file;
        try
        {
            var b = File.ReadAllBytes(file);
            if (b.Length < 100_000 || b.Length > 6_000_000 || b[0] != 0xE9) { Msg("Không phải file firmware ESP32 (firmware.bin, ~1 MB, bắt đầu bằng byte 0xE9).", true); return; }
            _fw = b; _go.Enabled = true;
            Msg($"{b.Length / 1024} KB · build {File.GetLastWriteTime(file):dd/MM/yyyy HH:mm}. Bấm Cập nhật để gửi lên board.", false);
        }
        catch (Exception e) { Msg(e.Message, true); }
    }

    void Msg(string t, bool err) { _msg.ForeColor = err ? Theme.Red : Theme.Muted; _msg.Text = t; }

    async Task GoAsync()
    {
        if (_fw == null || _busy) return;
        if (!Ask.Yes(this, "Gửi firmware này lên board? Board sẽ khởi động lại (~10 giây), thiết bị đang điều khiển tạm ngừng trong lúc đó.", "Cập nhật firmware")) return;
        _busy = true; _go.Enabled = _pick.Enabled = _close.Enabled = false; _bar.Value = 0; Msg("Đang gửi firmware…", false);
        try
        {
            var prog = new Progress<double>(p => { _bar.Value = (int)(p * 1000); Msg($"Đang gửi firmware… {p:P0}", false); });
            var r = await _client.OtaAsync(_fw, prog);
            _bar.Value = 1000; Updated = true;
            Msg(string.IsNullOrEmpty(r.Msg) ? "Đã nạp xong, board khởi động lại." : r.Msg, false);
            await Task.Delay(1200);
            DialogResult = DialogResult.OK; _busy = false; Close();
            return;
        }
        catch (Exception e) { Msg(RemoteClient.Explain(e), true); }
        _busy = false; _pick.Enabled = _close.Enabled = true; _go.Enabled = _fw != null;
    }

    /// <summary>true = đã cập nhật (board khởi động lại → nối lại).</summary>
    public static bool Run(IWin32Window owner, RemoteClient client, string currentVersion)
    {
        using var d = new FirmwareDialog(client, currentVersion);
        return d.ShowDialog(owner) == DialogResult.OK && d.Updated;
    }
}
