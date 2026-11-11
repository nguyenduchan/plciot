using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử thêm / sửa / xoá / tạm dừng thiết bị bằng hộp thoại thật (--edittest THƯ_MỤC), kết quả ở edit-result.txt (dòng cuối RESULT=PASS|FAIL).
/// Chạy với GATEWAYAPP_SETTINGS trỏ vào BẢN SAO cấu hình (không bao giờ chạy trên cấu hình thật).
/// Gồm lỗi từng gặp: gõ D mới nhưng chưa Enter rồi bấm Lưu thì giá trị phải được nhận.
/// </summary>
public sealed partial class MainForm
{
    public async Task EditTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        var fails = 0;
        void Check(string name, bool ok, string detail = "") { log.Add($"{(ok ? "PASS" : "FAIL")} {name} {detail}".TrimEnd()); if (!ok) fails++; }
        string Snap() => string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}@D{p.Address}{(p.Enabled ? "" : "!")}"));
        await Task.Delay(1500);
        log.Add("before: " + Snap());
        var none = new Dictionary<string, string>();
        var modbus = new Dictionary<string, string> { ["unit"] = "1" };

        // 1) SỬA: gõ D mới vào ô nhưng chưa Enter, bấm "Lưu thay đổi"
        var child = _cfg.Pack.First().Child; var field = _cfg.Pack.First().Field;
        var onClick = typeof(Control).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!;
        DeviceDialog.Hook = async d =>
        {
            await Task.Delay(600);
            var g = FindAll<DataGridView>(d).First();
            var row = g.Rows.Cast<DataGridViewRow>().First(r => !r.IsNewRow);
            g.CurrentCell = row.Cells[5];
            g.BeginEdit(false);
            ((TextBox)g.EditingControl!).Text = "61";          // gõ dở, chưa Enter
            await Task.Delay(300);
            onClick.Invoke(FindAll<FlatButton>(d).First(b => b.Caption == "Lưu thay đổi"), new object[] { EventArgs.Empty });
        };
        var ok = DeviceDialog.Run(this, this, child, out _);
        DeviceDialog.Hook = null;
        Check("edit_dialog_closed_ok", ok);
        Check("edit_uncommitted_cell_is_saved", _cfg.Pack.First(p => p.Child == child && p.Field == field).Address == 61, Snap());

        // 2) THÊM: bồn nước mới, D tự chọn không trùng
        var before = _cfg.Pack.Select(p => p.Child).ToHashSet();
        var err = AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 502, none, modbus);
        Check("add_ok", err.Length == 0, err);
        var added = _cfg.Pack.Select(p => p.Child).Distinct().FirstOrDefault(c => !before.Contains(c)) ?? "";
        Check("add_creates_device_and_meta", added.Length > 0 && _meta.Device(added) != null, added);

        // 3) THÊM TRÙNG D phải bị từ chối
        err = AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 502, none, modbus, g => g.Rows[0].Cells[5].Value = "61");
        Check("add_duplicate_d_rejected", err.Contains("D61"), err);
        Check("add_duplicate_did_not_change_config", _cfg.Pack.Select(p => p.Child).Distinct().Count() == before.Count + 1);

        // 4) TẠM DỪNG / CHẠY thiết bị vừa thêm
        Check("pause_ok", await SetDeviceEnabledAsync(added, false) == null && _cfg.Pack.Where(p => p.Child == added).All(p => !p.Enabled), Snap());
        Check("pause_other_devices_untouched", _cfg.Pack.Where(p => p.Child != added).All(p => p.Enabled));
        Check("resume_ok", await SetDeviceEnabledAsync(added, true) == null && _cfg.Pack.Where(p => p.Child == added).All(p => p.Enabled));
        Check("pause_unknown_device_rejected", await SetDeviceEnabledAsync("khong-co", false) != null);

        // 5) XOÁ
        DeviceDialog.Remove(this, added);
        Check("remove_pack_and_meta", _cfg.Pack.All(p => p.Child != added) && _meta.Device(added) == null && _meta.Map.Keys.All(k => !k.StartsWith(added + ".")), Snap());
        Check("remove_keeps_others", _cfg.Pack.Any(p => p.Child == child));

        // 6) cấu hình hợp lệ và lưu được sau tất cả thao tác
        Check("config_valid", _cfg.Validate() == null, _cfg.Validate() ?? "");

        log.Add("after: " + Snap());
        log.Add(fails == 0 ? "RESULT=PASS" : $"RESULT=FAIL ({fails})");
        File.WriteAllLines(Path.Combine(outDir, "edit-result.txt"), log);
        Environment.ExitCode = fails == 0 ? 0 : 1;
        Application.Exit();
    }
}
