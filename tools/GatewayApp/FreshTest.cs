using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử gateway MỚI TINH (--freshtest THƯ_MỤC --noauth; GATEWAYAPP_SETTINGS trỏ vào file chưa tồn tại): đăng ký lần đầu (cấp ID + QR),
/// thêm thiết bị bằng hộp thoại thật, chọn giải pháp UI, chờ user quét QR (script ngoài), nhận lệnh điều khiển từ cloud tới PLC.
/// Điều phối với script ngoài qua file trong THƯ_MỤC: qr.txt (app ghi khi đăng ký xong), cmd-sent.txt (script ghi sau khi gửi lệnh).
/// </summary>
public sealed partial class MainForm
{
    public async Task FreshTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void L(string s) { log.Add($"{DateTime.Now:HH:mm:ss} {s}"); File.WriteAllLines(Path.Combine(outDir, "fresh-log.txt"), log); }
        async Task<bool> Until(Func<bool> c, int sec) { for (var i = 0; i < sec * 4 && !c(); i++) await Task.Delay(250); return c(); }
        var api = CloudPage.ServerOf(_cfg);
        L($"khởi đầu: pack={_cfg.Pack.Count} mqttId='{_cfg.MqttId}' qr={_cfg.GatewayQr.Length} running={Running}");

        // 1) đăng ký lần đầu (--noauth + token đăng ký lấy sẵn thay cho bước đăng nhập)
        var reg = await Until(() => _cfg.MqttId.Length > 0 && _cfg.GatewayQr.Length > 0, 60);
        L($"đăng ký lần đầu: {(reg ? "OK" : "LỖI")} site={_cfg.Site} device={_cfg.Device} mqttId={_cfg.MqttId} cloud={_cfg.CloudHost}");
        if (!reg) { L("RESULT=FAIL"); Application.Exit(); return; }
        File.WriteAllText(Path.Combine(outDir, "qr.txt"), _cfg.GatewayQr);

        // 2) thêm thiết bị bằng hộp thoại thật
        var modbus = new Dictionary<string, string> { ["unit"] = "1" }; var none = new Dictionary<string, string>();
        var e1 = AddDeviceViaDialog("tank", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus);
        var e2 = AddDeviceViaDialog("pump", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus);
        L($"thêm bồn: {(e1.Length == 0 ? "OK" : "LỖI " + e1)}; thêm bơm: {(e2.Length == 0 ? "OK" : "LỖI " + e2)}");
        await ApplyAsync("fresh: thêm thiết bị");
        var up = await Until(() => Running, 20);
        L($"thông báo cuối: error={LastToast.Error} {LastToast.Text}");
        L($"pack={_cfg.Pack.Count} field, gateway chạy lại sau khi thêm thiết bị: {(up ? "OK" : "LỖI không chạy")}");

        // 4) chờ user quét QR → server báo claimed → gateway bắt đầu gửi telemetry
        var claimed = await Until(() => _cfg.CloudSendData, 120);
        L($"user quét QR → gateway nhận claimed: {(claimed ? "OK" : "LỖI (hết giờ)")}");

        // 5) đọc PLC và có số liệu
        var haveVals = await Until(() => TryValue("pump1.run", out _) && TryValue("tank1.level", out _), 30);
        TryValue("pump1.run", out var run0); TryValue("tank1.level", out var lvl);
        L($"đọc PLC: {(haveVals ? "OK" : "LỖI")} pump1.run={run0} tank1.level={lvl}");

        // 6) lệnh điều khiển từ cloud (script ngoài gửi) → PLC đổi giá trị
        var sent = await Until(() => File.Exists(Path.Combine(outDir, "cmd-sent.txt")), 90);
        if (sent)
        {
            var want = File.ReadAllText(Path.Combine(outDir, "cmd-sent.txt")).Trim() == "1" ? 1.0 : 0.0;
            var changed = await Until(() => TryValue("pump1.run", out var v) && Math.Abs(v - want) < 0.01, 30);
            TryValue("pump1.run", out var run1);
            L($"lệnh từ cloud pump1.run={want} → PLC: {(changed ? "OK" : "LỖI")} giá trị hiện tại={run1}");
        }
        else L("không nhận được tín hiệu đã gửi lệnh (script ngoài)");

        // 7) SAU KHI user đã quét QR: gateway thêm thiết bị mới → publish config → dashboard của user phải tự có thêm thiết bị đó
        //    (script ngoài ghi add-more.txt khi sẵn sàng, rồi tự hỏi dashboard để kiểm).
        if (await Until(() => File.Exists(Path.Combine(outDir, "add-more.txt")), 60))
        {
            var e3 = AddDeviceViaDialog("env", PlcSource.ModbusTcp, "127.0.0.1", 1502, none, modbus);
            await ApplyAsync("fresh: thêm thiết bị sau khi đã có user");
            var up2 = await Until(() => Running, 20);
            var haveEnv = await Until(() => TryValue("env1.t", out _), 20);
            L($"thêm cảm biến sau khi user đã quét: {(e3.Length == 0 ? "OK" : "LỖI " + e3)}; chạy lại: {(up2 ? "OK" : "LỖI")}; đọc env1.t: {(haveEnv ? "OK" : "LỖI")}; pack={_cfg.Pack.Count} field");
            File.WriteAllText(Path.Combine(outDir, "added-more.txt"), "1");
            await Task.Delay(15000);   // để script ngoài kịp hỏi dashboard + đọc telemetry mới
        }
        else L("không có yêu cầu thêm thiết bị lần hai (script ngoài)");
        await Task.Delay(8000);   // để telemetry cuối kịp lên server
        L("RESULT=DONE");
        Application.Exit();
    }
}
