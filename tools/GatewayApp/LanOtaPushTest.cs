namespace GatewayApp;

/// <summary>
/// Bản Debug: đẩy một firmware đã ký lên board qua LAN — đúng đường nút "Firmware…" (POST /api/ota), dùng khoá PC đã ghép.
///   GATEWAYAPP_SETTINGS=&lt;cấu hình&gt; GatewayApp.exe --lanotapush KQ.txt --board 192.168.1.200 --fw firmware.bin --manifest manifest.json
/// manifest.json: {version, sha256, sig} (fwsign / sign-mcu-firmware). Board có chủ phải đang trong cửa sổ chủ trạm cho phép.
/// </summary>
public sealed partial class MainForm
{
    public async Task LanOtaPushAsync(string result)
    {
        var log = new List<string>();
        void L(string s) => log.Add($"{DateTime.UtcNow.AddHours(7):HH:mm:ss} {s}");
        try
        {
            var host = (ArgValue(RunOptions.Args, "--board") is { Length: > 0 } b0 ? b0 : "192.168.1.200");
            var fw = File.ReadAllBytes(ArgValue(RunOptions.Args, "--fw"));
            using var m = System.Text.Json.JsonDocument.Parse(File.ReadAllText(ArgValue(RunOptions.Args, "--manifest")));
            var ver = m.RootElement.GetProperty("version").GetString()!; var sig = m.RootElement.GetProperty("sig").GetString()!;
            var c = (await RemoteClient.ConnectMcuAsync(host, 443, Identity(), _ => false)).Client;
            var st = await c.OtaStateAsync();
            L($"board {host}: {st}");
            var r = await c.OtaAsync(fw, ver, sig);
            L($"PASS đẩy {ver} ({fw.Length / 1024} KB) qua LAN: {r.Msg}");
        }
        catch (RemoteException e) { L($"FAIL {e.Code} {e.Message}"); }
        catch (Exception e) { L("FAIL " + e); }
        File.WriteAllLines(result, log);
        Application.Exit();
    }
}
