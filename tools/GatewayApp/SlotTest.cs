using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử GHÉP THIẾT BỊ VÀO SƠ ĐỒ giải pháp bằng hộp thoại "Thêm thiết bị" thật (--slottest THƯ_MỤC; kết quả slot-result.txt, dòng cuối RESULT=PASS|FAIL,
/// kèm ảnh hộp thoại slot-dialog.png). Chạy với GATEWAYAPP_SETTINGS trỏ vào BẢN SAO cấu hình có giải pháp (*.skin.json) — không chạy trên cấu hình thật.
/// Kiểm: có cột "Gắn vào sơ đồ"; chọn ô sơ đồ → tên field đổi thành khoá của ô + bỏ khoá MQTT; field không gắn giữ tên riêng;
/// lưu xong field gắn sơ đồ KHÔNG lặp thành widget, field riêng vẫn có thẻ widget.
/// </summary>
public sealed partial class MainForm
{
    public async Task SlotTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>(); var fails = 0;
        void Check(string name, bool ok, string detail = "") { log.Add($"{(ok ? "PASS" : "FAIL")} {name} {detail}".TrimEnd()); if (!ok) fails++; }
        await Task.Delay(1200);
        Check("solution_slots_loaded", SolutionHost.Slots.Count > 0, $"{SolutionHost.Name}: {SolutionHost.Slots.Count} ô");
        var slot = SolutionHost.Slots.FirstOrDefault();
        var onClick = typeof(Control).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!;
        string child = "";
        DeviceDialog.Hook = async d =>
        {
            await Task.Delay(700);
            var g = FindAll<DataGridView>(d).First();
            var col = g.Columns.Cast<DataGridViewColumn>().FirstOrDefault(c => c.HeaderText == "Gắn vào sơ đồ");
            Check("dialog_has_slot_column", col != null);
            var rows = g.Rows.Cast<DataGridViewRow>().Where(r => !r.IsNewRow).ToList();
            Check("template_has_rows", rows.Count >= 2, rows.Count.ToString());
            if (col != null && rows.Count >= 2 && slot.Keys != null)
            {
                rows[0].Cells[1].Value = "khoa_rieng";                       // khoá MQTT riêng phải bị bỏ khi gắn sơ đồ
                rows[0].Cells[col.Index].Value = $"{slot.Label} ({slot.Keys[0]})";
                await Task.Delay(200);
                Check("slot_sets_field_key", string.Equals(Convert.ToString(rows[0].Cells[0].Value), slot.Keys[0], StringComparison.OrdinalIgnoreCase), Convert.ToString(rows[0].Cells[0].Value));
                Check("slot_clears_mqtt_key", string.IsNullOrEmpty(Convert.ToString(rows[0].Cells[1].Value)));
                rows[1].Cells[0].Value = "rieng_x";                            // field tên riêng → widget ngoài
                await Task.Delay(200);
                Check("own_field_is_widget", Convert.ToString(rows[1].Cells[col.Index].Value) == "— Widget riêng —", Convert.ToString(rows[1].Cells[col.Index].Value));
            }
            try { using var bmp = new Bitmap(d.Width, d.Height); d.DrawToBitmap(bmp, new Rectangle(0, 0, d.Width, d.Height)); bmp.Save(Path.Combine(outDir, "slot-dialog.png")); } catch (Exception e) { log.Add("shot " + e.Message); }
            onClick.Invoke(FindAll<FlatButton>(d).First(b => b.Caption == "Thêm thiết bị"), new object[] { EventArgs.Empty });
        };
        var ok = DeviceDialog.Run(this, this, null, out child);
        DeviceDialog.Hook = null;
        Check("add_dialog_ok", ok, child);
        var mine = _cfg.Pack.Where(p => p.Child == child).ToList();
        Check("saved_slot_field", slot.Keys != null && mine.Any(p => string.Equals(p.Field, slot.Keys[0], StringComparison.OrdinalIgnoreCase) && string.IsNullOrEmpty(p.MqttKey)), string.Join(",", mine.Select(p => p.Field + (p.MqttKey.Length > 0 ? "→" + p.MqttKey : ""))));
        _dash.Rebuild();
        var cards = FindAll<DeviceCard>(_dash).Where(c => c.Child == child).ToList();
        Check("card_exists_for_own_fields", cards.Count == 1);
        Check("diagram_field_not_duplicated", !SolutionHost.InDiagram("rieng_x"));
        log.Add($"RESULT={(fails == 0 ? "PASS" : "FAIL")}");
        File.WriteAllLines(Path.Combine(outDir, "slot-result.txt"), log);
        Environment.ExitCode = fails == 0 ? 0 : 1;
        Application.Exit();
    }
}
