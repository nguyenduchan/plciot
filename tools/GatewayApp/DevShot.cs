using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

sealed partial class MainForm
{
    /// <summary>--devshot THƯ_MỤC: chụp hộp thoại thêm thiết bị (Tiêu chuẩn / Waveshare: cảm biến, điều khiển + phản hồi) rồi thoát.</summary>
    public async Task DevShotAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        try {
        using (var d0 = DeviceDialog.Preview(this, null)) { d0.Show(this); await Task.Delay(600); using var b0 = new Bitmap(d0.Width, d0.Height); d0.DrawToBitmap(b0, new Rectangle(0, 0, d0.Width, d0.Height)); b0.Save(Path.Combine(outDir, "std.png")); d0.GetType().GetMethod("PickTemplate", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.Invoke(d0, new object[] { DeviceTemplate.Find("diboard")!, true }); await Task.Delay(500); using var b1 = new Bitmap(d0.Width, d0.Height); d0.DrawToBitmap(b1, new Rectangle(0, 0, d0.Width, d0.Height)); b1.Save(Path.Combine(outDir, "pc-wire.png")); d0.Close(); }
        var pa = new PreviewApp(this) { GatewayKind = "mcu" };
        using var dlg = DeviceDialog.Preview(pa, null);
        dlg.Show(this); await Task.Delay(600);
        void Shot(string n) { using var b = new Bitmap(dlg.Width, dlg.Height); dlg.DrawToBitmap(b, new Rectangle(0, 0, dlg.Width, dlg.Height)); b.Save(Path.Combine(outDir, n + ".png")); }
        var t = dlg.GetType(); var nb = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
        Shot("ws-sensor");
        ((ComboBox)t.GetField("_wDi", nb)!.GetValue(dlg)!).SelectedIndex = 1; await Task.Delay(600); Shot("ws-ctl");
        // thêm thiết bị điều khiển DO3 + phản hồi DI5 rồi kiểm cấu hình kết quả
        ((ComboBox)t.GetField("_wDo", nb)!.GetValue(dlg)!).SelectedIndex = 3; ((ComboBox)t.GetField("_wDi", nb)!.GetValue(dlg)!).SelectedIndex = 5;
        t.GetMethod("Commit", nb)!.Invoke(dlg, null);
        var res = string.Join(", ", pa.Config.Pack.Select(p => $"{p.Child}.{p.Field}@D{p.Address}/{p.Access}/{p.Params.GetValueOrDefault("unit")}/{p.Source}"));
        var fbk = pa.Meta.Get(pa.Config.Pack[0].Child, pa.Config.Pack[0].Field)?.Feedback;
        File.WriteAllText(Path.Combine(outDir, "wire.txt"), res + " | feedback=" + fbk + " | result=" + dlg.DialogResult);
        dlg.Close(); } catch (Exception e) { File.WriteAllText(Path.Combine(outDir, "err.txt"), e.ToString()); } Application.Exit();
    }
}
