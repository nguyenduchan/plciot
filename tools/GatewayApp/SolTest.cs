using System.Text.Json;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử đổi giải pháp (UI) NGAY TRÊN GATEWAY (--soltest THƯ_MỤC): ghép cặp bằng mã tự duyệt (GW_PAIR_CODE, server GW_PAIR_API),
/// rồi lần lượt chọn giải pháp như người dùng bấm "Áp dụng" ở trang Cloud (GW_SOLUTIONS, mặc định aqua,hvac,"",tank) và ghi lại:
/// giải pháp trong cấu hình, file giao diện (*.skin.json: id + màu nền) sau mỗi lần đổi, và bản tin config sẽ publish.
/// Kết quả: soltest-result.txt. Dùng GATEWAYAPP_SETTINGS để không đụng cấu hình gateway thật.
/// </summary>
public sealed partial class MainForm
{
    public async Task SolTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        var api = Environment.GetEnvironmentVariable("GW_PAIR_API");
        if (string.IsNullOrEmpty(api)) api = "https://plc.dieukhientudong.net";
        var code = Environment.GetEnvironmentVariable("GW_TEST_TOKEN");
        var seq = (Environment.GetEnvironmentVariable("GW_SOLUTIONS") ?? "aqua,hvac,,tank").Split(',');
        string Skin()
        {
            try
            {
                if (!File.Exists(SkinStore.PathFor)) return "(không có file giao diện = bản cơ bản)";
                using var d = JsonDocument.Parse(File.ReadAllText(SkinStore.PathFor));
                var r = d.RootElement;
                return $"id={r.GetProperty("id").GetString()} bg={r.GetProperty("palette").GetProperty("bg").GetString()} acc={r.GetProperty("palette").GetProperty("acc").GetString()}";
            }
            catch (Exception e) { return "lỗi đọc: " + e.Message; }
        }
        string Sent() { try { using var d = JsonDocument.Parse(ConfigBuilder.Build(_cfg, new MetaDescriber(_meta, _cfg))); return d.RootElement.GetProperty("solution").GetString() ?? "(null)"; } catch (Exception e) { return "lỗi: " + e.Message; } }

        var list = await CloudAsync("solutions", api, "");
        log.Add($"danh sách giải pháp từ server: ok={list.Ok} {(list.Ok ? list.Msg.Length + " byte" : list.Msg)}");
        if (!string.IsNullOrEmpty(code))
        {
            await TestRegisterAsync(api, code);
            log.Add($"pair: error={LastToast.Error} text={LastToast.Text} site={_cfg.Site} device={_cfg.Device} cfg.Solution='{_cfg.Solution}' skin: {Skin()}");
        }
        foreach (var id in seq)
        {
            var r = await CloudAsync("solution", api, id);
            log.Add($"chọn '{id}': ok={r.Ok} msg={r.Msg} | cfg.Solution='{_cfg.Solution}' | config gửi lên server solution='{Sent()}' | skin: {Skin()}");
        }
        File.WriteAllLines(Path.Combine(outDir, "soltest-result.txt"), log);
        await StopAsync();
        Close();
    }
}
