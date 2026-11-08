using System.Globalization;
using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Chạy thử không cần bấm tay: thêm thiết bị bằng hộp thoại thật (chọn loại → bấm Thêm), chạy gateway Modbus TCP, đọc và ghi giá trị.</summary>
public sealed partial class MainForm
{
    string AddDeviceViaDialog(string templateId)
    {
        using var dlg = DeviceDialog.Preview(this, null);
        var t = dlg.GetType();
        t.GetMethod("PickTemplate", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(dlg, new object[] { DeviceTemplate.Find(templateId)!, true });
        t.GetMethod("Commit", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(dlg, null);
        if (dlg.DialogResult == DialogResult.OK) return "";
        return ((Label)t.GetField("_err", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(dlg)!).Text is { Length: > 0 } e ? e : "không đóng với OK";
    }

    string Snapshot() => string.Join(" ", _cfg.Pack.Select(p =>
        TryValue(UiMetaStore.Key(p.Child, p.Field), out var v) ? $"{p.Child}.{p.Field}={v.ToString("0.##", CultureInfo.InvariantCulture)}" : $"{p.Child}.{p.Field}=?"));

    public async Task SelfTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string> { $"empty_on_start={_cfg.Pack.Count == 0}" };
        _cfg.Source = PlcSource.ModbusTcp; _cfg.PlcHost = "127.0.0.1"; _cfg.PlcPort = 1502; _cfg.Mobile = MobileAccess.Off; _cfg.PollMs = 500;
        foreach (var tpl in new[] { "tank", "pump", "env" }) log.Add($"add {tpl}: {(AddDeviceViaDialog(tpl) is { Length: > 0 } e ? "LOI " + e : "ok")}");
        log.Add("pack: " + string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}@D{p.Address}x{p.Scale}")));
        _dash.Rebuild();
        await StartAsync();
        log.Add($"running={Running} plc_status={_host?.Core.State.Status}");
        await Task.Delay(9000);
        log.Add($"plc_status_after={_host?.Core.State.Status}");
        log.Add("read1: " + Snapshot());
        log.Add($"write run=0 -> {await WriteAsync("pump1", "run", 0) ?? "ok"}");
        log.Add($"write speed=80 -> {await WriteAsync("pump1", "speed", 80) ?? "ok"}");
        log.Add($"write speed=500 -> {await WriteAsync("pump1", "speed", 500) ?? "ok"}");
        await Task.Delay(4000);
        log.Add("read2: " + Snapshot());
        log.Add($"write run=1 -> {await WriteAsync("pump1", "run", 1) ?? "ok"}");
        await Task.Delay(6000);
        log.Add("read3: " + Snapshot());
        // xoá thiết bị qua đúng trang Thiết bị: chọn dòng của env1 rồi bấm Xoá; từ chối thì còn, đồng ý thì mất và gateway chạy lại
        var page = typeof(MainForm).GetField("_devices", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(this)!;
        var grid = (DataGridView)page.GetType().GetField("_g", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(page)!;
        var del = page.GetType().GetMethod("Delete", BindingFlags.NonPublic | BindingFlags.Instance)!;
        Show(_devices);   // như người dùng mở trang Thiết bị: lưới được nạp lại
        foreach (DataGridViewRow r in grid.Rows) if (Convert.ToString(r.Cells[0].Tag) == "env1") { grid.CurrentCell = r.Cells[0]; break; }
        var n0 = _cfg.Pack.Count;
        Ask.Override = false; await (Task)del.Invoke(page, null)!;
        log.Add($"delete_declined_kept={_cfg.Pack.Count == n0}");
        Ask.Override = true; await (Task)del.Invoke(page, null)!;
        log.Add($"delete_confirmed_removed={!_cfg.Pack.Any(p => p.Child == "env1") && _meta.Device("env1") == null && _cfg.Pack.Count == n0 - 2} running_after={Running}");
        Ask.Override = null;
        await Task.Delay(5000);
        log.Add($"plc_status_after_delete={_host?.Core.State.Status}");
        log.Add("read4: " + Snapshot());
        File.WriteAllLines(Path.Combine(outDir, "gateway-result.txt"), log);
        await StopAsync();
        Close();
    }
}
