using System.Reflection;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Kiểm thử sửa thiết bị bằng hộp thoại thật (--edittest THƯ_MỤC): gõ giá trị mới vào ô D nhưng CHƯA Enter, rồi bấm "Lưu thay đổi".
/// Ô bảng đang gõ dở phải được chốt, nếu không thanh ghi D mới bị bỏ sót. Chạy với GATEWAYAPP_SETTINGS trỏ vào bản sao cấu hình.
/// </summary>
public sealed partial class MainForm
{
    public async Task EditTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        await Task.Delay(1500);
        string Snap() => string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}@D{p.Address}"));
        log.Add("before: " + Snap());
        var child = _cfg.Pack.First().Child;
        var onClick = typeof(Control).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!;
        DeviceDialog.Hook = async d =>
        {
            await Task.Delay(600);
            var g = FindAll<DataGridView>(d).First();
            var row = g.Rows.Cast<DataGridViewRow>().First(r => !r.IsNewRow);
            g.CurrentCell = row.Cells[5];
            g.BeginEdit(false);
            ((TextBox)g.EditingControl!).Text = "61";          // gõ dở, chưa Enter
            log.Add($"cell_value_before_save={row.Cells[5].Value} editing={g.IsCurrentCellInEditMode}");
            await Task.Delay(300);
            var save = FindAll<FlatButton>(d).First(b => b.Caption == "Lưu thay đổi");
            onClick.Invoke(save, new object[] { EventArgs.Empty });
        };
        var ok = DeviceDialog.Run(this, this, child, out _);
        DeviceDialog.Hook = null;
        log.Add($"dialog_ok={ok}");
        log.Add("after: " + Snap());
        File.WriteAllLines(Path.Combine(outDir, "edit-result.txt"), log);
        Application.Exit();
    }
}
