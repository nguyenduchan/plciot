using System.Globalization;
using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Chạy thử không cần bấm tay, tới PlcSim thật (cấu hình mẫu e2e/plcsim-settings.json): thêm thiết bị bằng hộp thoại thật
/// (chọn giao thức, kết nối, thông số riêng, quyền, kiểu dữ liệu), chạy gateway nhiều giao thức cùng lúc (Modbus TCP + OPC UA), đọc/ghi, xoá.
/// </summary>
public sealed partial class MainForm
{
    const BindingFlags NP = BindingFlags.NonPublic | BindingFlags.Instance;
    static T F<T>(object o, string name) => (T)o.GetType().GetField(name, NP)!.GetValue(o)!;

    static void Set(Control c, string v)
    {
        if (c is ComboBox cb) cb.SelectedItem = v; else c.Text = v;
    }

    /// <summary>Thêm một thiết bị qua hộp thoại thật. Trả về thông báo lỗi của hộp thoại (rỗng = thành công).</summary>
    string AddDeviceViaDialog(string templateId, PlcSource src, string host, int port, Dictionary<string, string> opts, Dictionary<string, string> prm, Action<DataGridView>? tweak = null, Action<Form>? dlgTweak = null)
    {
        using var dlg = DeviceDialog.Preview(this, null);
        var t = dlg.GetType();
        F<ComboBox>(dlg, "_proto").SelectedIndex = Array.IndexOf(ProtocolSpec.Streamable, src);        // dựng lại ô kết nối + thông số của giao thức
        t.GetMethod("PickTemplate", NP)!.Invoke(dlg, new object[] { DeviceTemplate.Find(templateId)!, true });
        var conn = F<Dictionary<string, Control>>(dlg, "_connInputs");
        if (conn.TryGetValue("host", out var h)) h.Text = host;
        if (conn.TryGetValue("port", out var p)) p.Text = port.ToString();
        foreach (var (k, v) in opts) Set(conn[k], v);
        foreach (var (k, v) in prm) Set(F<Dictionary<string, Control>>(dlg, "_paramInputs")[k], v);
        tweak?.Invoke(F<DataGridView>(dlg, "_g"));
        dlgTweak?.Invoke(dlg);
        t.GetMethod("Commit", NP)!.Invoke(dlg, null);
        if (dlg.DialogResult == DialogResult.OK) return "";
        return F<Label>(dlg, "_err").Text is { Length: > 0 } e ? e : "không đóng với OK";
    }

    string Snapshot() => string.Join(" ", _cfg.Pack.Select(p =>
        TryValue(UiMetaStore.Key(p.Child, p.Field), out var v) ? $"{p.Child}.{p.Field}={v.ToString("0.##", CultureInfo.InvariantCulture)}" : $"{p.Child}.{p.Field}=?"));

    public async Task SelfTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string> { $"empty_on_start={_cfg.Pack.Count == 0}" };
        _cfg.Mobile = MobileAccess.Off; _cfg.PollMs = 500;

        // chưa có thiết bị vẫn chạy được (chờ thiết bị; không đọc D0–D39 ngầm định)
        await StartAsync();
        log.Add($"start_without_devices={Running}");
        await StopAsync();

        var modbus = new Dictionary<string, string> { ["unit"] = "1" };
        var none = new Dictionary<string, string>();
        log.Add($"add tank: {(AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus) is { Length: > 0 } e1 ? "LOI " + e1 : "ok")}");
        log.Add($"add pump: {(AddDeviceViaDialog("pump", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus) is { Length: > 0 } e2 ? "LOI " + e2 : "ok")}");
        // env: nhiệt độ là REAL (2 word) → độ ẩm phải dời sang D57
        log.Add($"add env: {(AddDeviceViaDialog("env", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus, g =>
        {
            foreach (DataGridViewRow r in g.Rows)
            {
                if (Convert.ToString(r.Cells[0].Value) == "t") r.Cells[3].Value = "REAL";
                if (Convert.ToString(r.Cells[0].Value) == "h") r.Cells[4].Value = "57";
            }
        }) is { Length: > 0 } e3 ? "LOI " + e3 : "ok")}");
        // van: giao thức KHÁC (OPC UA) trên cùng chương trình, thanh ghi D60
        log.Add($"add valve(opcua): {(AddDeviceViaDialog("valve", PlcSource.OpcUa, "127.0.0.1", 4841, new() { ["path"] = "plcsim", ["security"] = "none" },
            new() { ["ns"] = "2", ["image"] = "PLC_D", ["prefix"] = "PLC_W" }, g => g.Rows[0].Cells[4].Value = "60") is { Length: > 0 } e4 ? "LOI " + e4 : "ok")}");
        // thêm trùng thanh ghi trên cùng PLC phải bị từ chối
        log.Add($"dup_word_rejected={AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus, g => g.Rows[0].Cells[4].Value = "52").Contains("D52")}");
        // thiếu kết nối / thông số phải bị từ chối
        log.Add($"missing_host_rejected={AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "", 1502, none, modbus, g => g.Rows[0].Cells[4].Value = "90").Contains("địa chỉ")}");
        log.Add("pack: " + string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}@D{p.Address}x{p.Scale}/{p.Protocol}/{p.Access}/{p.DataType}")));
        log.Add("connections: " + string.Join(", ", _cfg.Connections.Select(c => $"{c.Protocol}={c.Host}:{c.Port}")));
        log.Add($"validate={_cfg.Validate() ?? "ok"}");
        _dash.Rebuild();

        await StartAsync();
        log.Add($"running={Running} plc_status={_host?.Core.State.Status}");
        await Task.Delay(9000);
        log.Add($"plc_status_after={_host?.Core.State.Status}");
        log.Add("read1: " + Snapshot());
        log.Add($"write pump1.run=0 -> {await WriteAsync("pump1", "run", 0) ?? "ok"}");
        log.Add($"write pump1.speed=80 -> {await WriteAsync("pump1", "speed", 80) ?? "ok"}");
        log.Add($"write pump1.speed=500 -> {await WriteAsync("pump1", "speed", 500) ?? "ok"}");        // ngoài Min–Max
        log.Add($"write tank1.level=10 (chỉ đọc) -> {await WriteAsync("tank1", "level", 10) ?? "ok"}");
        log.Add($"write env1.t=1 (REAL, chỉ đọc) -> {await WriteAsync("env1", "t", 1) ?? "ok"}");
        log.Add($"write valve1.on=1 (OPC UA) -> {await WriteAsync("valve1", "on", 1) ?? "ok"}");
        await Task.Delay(4000);
        log.Add("read2: " + Snapshot());
        log.Add($"write pump1.run=1 -> {await WriteAsync("pump1", "run", 1) ?? "ok"}");
        await Task.Delay(3000);
        log.Add("read3: " + Snapshot());
        // xoá thiết bị qua đúng trang Thiết bị: chọn dòng của env1 rồi bấm Xoá; từ chối thì còn, đồng ý thì mất và gateway chạy lại
        var page = typeof(MainForm).GetField("_devices", NP)!.GetValue(this)!;
        var grid = (DataGridView)page.GetType().GetField("_g", NP)!.GetValue(page)!;
        var del = page.GetType().GetMethod("Delete", NP)!;
        Show(_devices);   // như người dùng mở trang Thiết bị: lưới được nạp lại
        foreach (DataGridViewRow r in grid.Rows) if (Convert.ToString(r.Cells[0].Tag) == "env1") { grid.CurrentCell = r.Cells[0]; break; }
        var n0 = _cfg.Pack.Count;
        Ask.Override = false; await (Task)del.Invoke(page, null)!;
        log.Add($"delete_declined_kept={_cfg.Pack.Count == n0}");
        Ask.Override = true; await (Task)del.Invoke(page, null)!;
        log.Add($"delete_confirmed_removed={!_cfg.Pack.Any(p => p.Child == "env1") && _meta.Device("env1") == null && _cfg.Pack.Count == n0 - 2} running_after={Running}");
        Ask.Override = null;
        await Task.Delay(4000);
        log.Add($"plc_status_after_delete={_host?.Core.State.Status}");
        log.Add("read4: " + Snapshot());
        File.WriteAllLines(Path.Combine(outDir, "gateway-result.txt"), log);
        await StopAsync();
        Close();
    }
}
