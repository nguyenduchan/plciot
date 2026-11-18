using System.Diagnostics;
using System.Text.Json;

namespace PlcSim;

/// <summary>
/// Chọn GIẢI PHÁP như trên gateway: PlcSim dựng đủ luồng dữ liệu mà giao diện giải pháp cần (solutions/&lt;id&gt;/gateway/setup.json, giá trị theo spec).
/// Mỗi giải pháp một HỒ SƠ riêng (profiles/&lt;id&gt;.json cạnh settings.json): chỉnh sửa luồng/giá trị được lưu lại, lần sau chọn lại là thử tiếp.
/// "▶ Mở GatewayApp thử": ghi cấu hình gateway riêng cho giải pháp (gateway/&lt;id&gt;/config.json — Pack khớp D, giao diện giải pháp)
/// rồi mở GatewayApp đọc thẳng PlcSim qua Modbus TCP; cấu hình gateway thật không bị đụng tới.
/// Dòng lệnh (kiểm thử tự động): --solution ID  --modbus-port N  --gateway "THAM_SỐ_GATEWAY"  --exit-with-gateway
/// </summary>
public sealed partial class MainForm
{
    readonly ComboBox _solBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 330, Margin = new Padding(4, 5, 0, 0) };
    readonly Button _solReload = new() { Text = "↺ Nạp lại mẫu", AutoSize = true, Height = 30 };
    readonly Button _gwBtn = new() { Text = "▶ Mở GatewayApp thử", AutoSize = true, Height = 30, BackColor = Color.FromArgb(46, 160, 67), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
    readonly CheckBox _gwNoAuth = new() { Text = "Bỏ qua đăng nhập gateway (chỉ thử giao diện)", Checked = true, AutoSize = true, Margin = new Padding(10, 9, 0, 0) };
    readonly Label _solInfo = new() { AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(10, 9, 0, 0) };
    List<SolutionKit.Info> _sols = new();
    /// <summary>Giải pháp đang thử ("" = tự cấu hình, dùng settings.json như trước).</summary>
    string _solution = "";
    bool _solSwitching;
    Process? _gwProc;

    static string DataDir => Path.GetDirectoryName(SettingsPath)!;
    static string ProfilePath(string id) => id.Length == 0 ? SettingsPath : Path.Combine(DataDir, "profiles", id + ".json");
    static string GatewayDir(string id) => Path.Combine(DataDir, "gateway", id);
    SolutionKit.Info? Sol(string id) => _sols.FirstOrDefault(s => s.Id == id);

    Control BuildSolutionBar()
    {
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8, 8, 8, 0), BackColor = Color.FromArgb(240, 245, 252) };
        _sols = SolutionKit.List();
        _solBox.Items.Add("Tự cấu hình (không theo giải pháp)");
        foreach (var s in _sols) _solBox.Items.Add($"{s.Title}  ({s.Id})");
        _solBox.SelectedIndex = 0;
        if (_sols.Count == 0) { _solBox.Enabled = false; _solInfo.Text = "Không thấy thư mục solutions/ (đặt PLCSIM_SOLUTIONS)."; }
        _solBox.SelectedIndexChanged += async (_, _) =>
        {
            if (_solSwitching) return;
            var id = _solBox.SelectedIndex <= 0 ? "" : _sols[_solBox.SelectedIndex - 1].Id;
            if (id != _solution) await SwitchSolutionAsync(id);
        };
        _solReload.Click += async (_, _) => await ReloadSolutionAsync();
        _gwBtn.Click += async (_, _) => await OpenGatewayAsync(_gwNoAuth.Checked ? new[] { "--noauth" } : Array.Empty<string>());
        bar.Controls.AddRange(new Control[] { new Label { Text = "Giải pháp:", AutoSize = true, Margin = new Padding(0, 9, 0, 0), Font = new Font("Segoe UI Semibold", 9f) }, _solBox, _solReload, _gwBtn, _gwNoAuth, _solInfo });
        return bar;
    }

    void SyncSolutionUi()
    {
        _solSwitching = true;
        var i = _sols.FindIndex(s => s.Id == _solution);
        _solBox.SelectedIndex = i < 0 ? 0 : i + 1;
        _solSwitching = false;
        _solReload.Enabled = _gwBtn.Enabled = _solution.Length > 0;
        var n = Streams().Count();
        _solInfo.Text = _solution.Length == 0 ? "Luồng tự khai báo (settings.json)" : $"Hồ sơ {_solution}: {n} luồng · lưu tự động ({Path.GetFileName(ProfilePath(_solution))})";
        Text = _solution.Length == 0 ? "PLC Simulator — giả lập PLC qua Ethernet" : $"PLC Simulator — {Sol(_solution)?.Title ?? _solution}";
    }

    /// <summary>Gọi trong constructor sau LoadSettings: áp tham số dòng lệnh rồi cập nhật thanh giải pháp.</summary>
    void InitSolutions()
    {
        var args = Environment.GetCommandLineArgs();
        var i = Array.IndexOf(args, "--solution");
        if (i >= 0 && i + 1 < args.Length && Sol(args[i + 1]) != null && args[i + 1] != _solution) SwitchCore(args[i + 1]);
        var p = Array.IndexOf(args, "--modbus-port");
        if (p >= 0 && p + 1 < args.Length && int.TryParse(args[p + 1], out var port) && port is >= 1 and <= 65535) Cfg("modbus").Port = port;
        SyncSolutionUi(); UpdateSummary();
        var shot = Array.IndexOf(args, "--uishot");   // --uishot FILE.png: chụp cửa sổ PlcSim rồi thoát (kiểm tra giao diện)
        if (shot >= 0 && shot + 1 < args.Length)
            Shown += async (_, _) =>
            {
                await Task.Delay(1500);
                using var bmp = new Bitmap(Width, Height); DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height)); bmp.Save(args[shot + 1]);
                Close();
            };
        var g = Array.IndexOf(args, "--gateway");
        if (g >= 0 && g + 1 < args.Length)
            Shown += async (_, _) =>
            {
                var proc = await OpenGatewayAsync(args[g + 1].Split(' ', StringSplitOptions.RemoveEmptyEntries));
                if (proc != null && args.Contains("--exit-with-gateway")) { await proc.WaitForExitAsync(); Close(); }
            };
    }

    void ClearModel()
    {
        foreach (var f in _model.Fields().ToList()) _model.RemoveField(f.Child, f.Field);
    }

    void ApplyRows(IEnumerable<SolutionKit.Row> rows)
    {
        foreach (var r in rows)
        {
            _model.SetMeta(r.Child, r.Field, new PlcModel.Meta("modbus", r.Writable ? PlcModel.Access.ReadWrite : PlcModel.Access.Read, "unit=1", PlcModel.DataType.Float32));
            _model.MapField(r.Child, r.Field, r.Addr, 1);
            _model.SetMode(r.Child, r.Field, r.Gen);
            _model.SetField(r.Child, r.Field, r.Value, "ui");
        }
    }

    /// <summary>Đổi hồ sơ (không chạy máy chủ): lưu hồ sơ đang mở, nạp hồ sơ của giải pháp mới (chưa có thì dựng từ giải pháp).</summary>
    void SwitchCore(string id)
    {
        SaveSettings();
        ClearModel(); _cfg.Clear();
        _solution = id;
        if (!LoadFrom(ProfilePath(id)) && Sol(id) is { } s)
        {
            var rows = SolutionKit.Build(s);
            ApplyRows(rows);
            AppendLog($"Giải pháp {s.Title}: dựng {rows.Count} luồng từ solutions/{s.Id}/gateway/setup.json (Modbus TCP, REAL, D{SolutionKit.FirstAddr}–D{(rows.Count == 0 ? SolutionKit.FirstAddr : rows[^1].Addr + 1)}).");
        }
        else AppendLog(id.Length == 0 ? "Về luồng tự khai báo." : $"Đã mở lại hồ sơ đã lưu của giải pháp {id}.");
        SaveSettings();
        RefreshStreams(); UpdateSummary(); SyncSolutionUi();
    }

    async Task SwitchSolutionAsync(string id)
    {
        var run = _eps.Count > 0;
        if (run) await StopAsync();
        try { SwitchCore(id); }
        catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException) { AppendLog($"Không nạp được giải pháp {id}: {e.Message}"); }
        if (run) await ToggleAsync();
    }

    async Task ReloadSolutionAsync()
    {
        if (Sol(_solution) is not { } s) return;
        if (!Ask.Yes(this, $"Dựng lại toàn bộ luồng của \"{s.Title}\" theo mẫu giải pháp?\n\nMọi chỉnh sửa trong hồ sơ này sẽ mất.", "Nạp lại mẫu giải pháp")) return;
        var run = _eps.Count > 0;
        if (run) await StopAsync();
        ClearModel(); _cfg.Clear();
        var rows = SolutionKit.Build(s); ApplyRows(rows);
        SaveSettings(); RefreshStreams(); UpdateSummary(); SyncSolutionUi();
        AppendLog($"Đã dựng lại {rows.Count} luồng theo mẫu {s.Id}.");
        if (run) await ToggleAsync();
    }

    /// <summary>Ghi cấu hình gateway thử của giải pháp đang chọn, bật máy chủ PlcSim nếu chưa chạy rồi mở GatewayApp.</summary>
    async Task<Process?> OpenGatewayAsync(IEnumerable<string> extra)
    {
        if (Sol(_solution) is not { } s) { AppendLog("Chọn một giải pháp trước khi mở GatewayApp thử."); return null; }
        var exe = SolutionKit.GatewayExe();
        if (exe == null) { AppendLog("Không thấy GatewayApp.exe — build trước: dotnet build tools/GatewayApp (hoặc đặt PLCSIM_GATEWAYAPP)."); return null; }
        var pack = Streams().Where(x => x.Kind == "modbus" && x.Addr >= 0).Select(x => new SolutionKit.PackRow(x.Child, x.Field, x.Addr, x.Scale, x.Access, x.Type)).ToList();
        var skipped = Streams().Count(x => x.Kind != "modbus");
        if (pack.Count == 0) { AppendLog("Hồ sơ không có luồng Modbus TCP nào để gateway đọc."); return null; }
        string cfg;
        try { cfg = SolutionKit.WriteGatewayProfile(s, SolutionKit.Build(s), pack, GatewayDir(s.Id), "127.0.0.1", Cfg("modbus").Port); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { AppendLog("Không ghi được cấu hình gateway thử: " + e.Message); return null; }
        if (_eps.Count == 0) await ToggleAsync();
        if (_eps.All(e => e.Kind != "modbus")) { AppendLog("Máy chủ Modbus TCP chưa chạy — gateway sẽ không đọc được."); }
        if (_gwProc is { HasExited: false }) AppendLog("Lưu ý: GatewayApp thử trước đó vẫn đang mở.");
        _gwProc = SolutionKit.LaunchGateway(exe, cfg, extra);
        AppendLog($"Đã mở GatewayApp thử ({s.Id}): {pack.Count} field qua Modbus TCP 127.0.0.1:{Cfg("modbus").Port}{(skipped > 0 ? $", bỏ {skipped} luồng không phải Modbus" : "")}. Cấu hình: {cfg}");
        return _gwProc;
    }
}
