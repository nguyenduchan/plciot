using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử luồng đăng ký (--pairtest THƯ_MỤC), dùng hộp thoại và nút thật:
///   1. thêm bồn nước + bơm bằng hộp thoại (màu nhấn, biểu tượng, khoá MQTT riêng cho field speed),
///   2. chụp Tổng quan + hộp thoại có khung xem trước,
///   3. nhập mã ghép cặp (GW_PAIR_CODE) vào trang Cloud và bấm "Gửi bản khai cho admin" tới GW_PAIR_API,
///   4. nếu có GW_QR (QR admin cấp): bấm Enroll và ghi site/device nhận được; field đã khai báo phải giữ nguyên.
/// Kết quả ghi vào pairtest-result.txt.
/// </summary>
public sealed partial class MainForm
{
    async Task Shot(string path)
    {
        await Task.Delay(1200);
        using var bmp = new Bitmap(Width, Height);
        DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
        bmp.Save(path);
    }

    public async Task PairTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        WindowState = FormWindowState.Normal; Size = new Size(1400, 860);
        _cfg.Mobile = MobileAccess.Off; _cfg.PollMs = 500;
        var none = new Dictionary<string, string>();
        var modbus = new Dictionary<string, string> { ["unit"] = "1" };

        if (_cfg.Pack.Count == 0)
        {
            log.Add($"add tank: {(AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus, null, d =>
            {
                F<ComboBox>(d, "_color").SelectedIndex = Array.IndexOf(DeviceStyle.ColorKeys, "blue");
                F<TextBox>(d, "_title").Text = "Bồn nước chính";
            }) is { Length: > 0 } e1 ? "LOI " + e1 : "ok")}");
            log.Add($"add pump: {(AddDeviceViaDialog("pump", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus, g =>
            {
                foreach (DataGridViewRow r in g.Rows)
                    if (Convert.ToString(r.Cells[0].Value) == "speed") r.Cells[1].Value = "q_speed";     // khoá MQTT khác tên field nội bộ
            }, d =>
            {
                F<ComboBox>(d, "_color").SelectedIndex = Array.IndexOf(DeviceStyle.ColorKeys, "green");
                F<ComboBox>(d, "_icon").SelectedIndex = 5;       // biểu tượng "Đồng hồ điện năng" thay vì theo loại
            }) is { Length: > 0 } e2 ? "LOI " + e2 : "ok")}");
        }
        log.Add("pack: " + string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}→{p.WireKey}")));
        log.Add($"validate={_cfg.Validate() ?? "ok"}");
        _dash.Rebuild();
        Show(_dash); Tick();
        await Shot(Path.Combine(outDir, "gateway-dashboard.png"));
        foreach (var (name, edit) in new[] { ("gateway-dialog-edit-pump", "pump1") })
        {
            using var dlg = DeviceDialog.Preview(this, edit);
            dlg.Show(this); await Task.Delay(1000);
            using var bmp = new Bitmap(dlg.Width, dlg.Height);
            dlg.DrawToBitmap(bmp, new Rectangle(0, 0, dlg.Width, dlg.Height));
            bmp.Save(Path.Combine(outDir, name + ".png"));
            dlg.Close();
        }

        var api = Environment.GetEnvironmentVariable("GW_PAIR_API");
        var code = Environment.GetEnvironmentVariable("GW_PAIR_CODE");
        var qr = Environment.GetEnvironmentVariable("GW_QR");
        if (string.IsNullOrEmpty(api)) api = "https://plc.dieukhientudong.net";
        log.Add($"fingerprint={Fingerprint.Of(_cfg)}");
        log.Add("config_json=" + System.Text.Encoding.UTF8.GetString(ConfigBuilder.Build(_cfg, new MetaDescriber(_meta, _cfg))));
        if (!string.IsNullOrEmpty(code))
        {
            await PairAsync(api, code);
            log.Add($"pair: error={LastToast.Error} text={LastToast.Text}");
        }
        if (!string.IsNullOrEmpty(qr))
        {
            var before = _cfg.Pack.Count;
            await EnrollAsync(api, qr);
            log.Add($"enroll_toast: error={LastToast.Error} text={LastToast.Text}");
            log.Add($"enroll: site={_cfg.Site} device={_cfg.Device} cloudHost={_cfg.CloudHost} pack_before={before} pack_after={_cfg.Pack.Count} keys_kept={_cfg.Pack.Any(p => p.MqttKey == "q_speed")}");
        }
        Show(_dash); Tick();
        await Shot(Path.Combine(outDir, "gateway-dashboard.png"));
        File.WriteAllLines(Path.Combine(outDir, "pairtest-result.txt"), log);
        await StopAsync();
        Close();
    }
}
