using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử cập nhật firmware board Waveshare đang là SLAVE của gateway PC (bản Debug) — đúng đường thật:
///   GATEWAYAPP_SETTINGS=&lt;BẢN SAO cấu hình gateway PC đã ghép cloud&gt; GATEWAYAPP_LOGFILE=&lt;file&gt;
///   GatewayApp.exe --boardotarelaytest THƯ_MỤC --board 192.168.1.200 --hw &lt;mã phần cứng board&gt; [--minutes 40]
/// Gateway PC đọc board bằng Modbus TCP và giữ lease (board tạm dừng MQTTS — không tự lên cloud). Bài thử KHÔNG tự duyệt:
/// chủ trạm bấm "Cho phép cập nhật" trên webapp → BoardOtaRelay (chạy trong nhịp lease như bản thật) hỏi server, chuyển lệnh cho phép
/// do server ký, tải firmware, đẩy qua LAN. Ghi status.txt mỗi 5 giây (lease + trạng thái OTA của board) và events.txt khi có thay đổi.
/// Dừng sớm: tạo file cmd.txt chứa "quit".
/// </summary>
public sealed partial class MainForm
{
    public async Task BoardOtaRelayTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var events = Path.Combine(outDir, "events.txt");
        void Ev(string s) { lock (outDir) File.AppendAllText(events, $"{DateTime.UtcNow.AddHours(7):HH:mm:ss} {s}{Environment.NewLine}"); }
        var host = (ArgValue(RunOptions.Args, "--board") is { Length: > 0 } b0 ? b0 : "192.168.1.200");
        var hw = ArgValue(RunOptions.Args, "--hw");
        var minutes = int.TryParse(ArgValue(RunOptions.Args, "--minutes"), out var mm) ? mm : 40;
        try
        {
            // board đã tin cậy (đã ghép từ trước) ở địa chỉ này, chế độ SLAVE với gateway PC này — file riêng của bài thử
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
            if (hw.Length > 0) TrustedBoards.Add(hw, host);
            foreach (var h in TrustedBoards.All().Keys) TrustedBoards.SetMode(h, TrustedBoards.Slave);
            await StopAsync();
            _cfg.Source = PlcSource.ModbusTcp; _cfg.PlcHost = host; _cfg.PlcPort = 502; _cfg.PollMs = 1000;
            _cfg.Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = host, Port = 502 } };
            _cfg.Pack = new() { new PackMap { Child = "board", Field = "do1", MqttKey = "do1", Address = 20, Protocol = "ModbusTcp", Access = PackAccess.Read, Params = new() { ["unit"] = "0" } } };
            await StartAsync();
            Ev($"gateway {_cfg.Site}/{_cfg.Device} chạy, board {host} ({hw}), server {CloudPage.ServerOf(_cfg)}");
            string last = "";
            RemoteClient? probe = null;   // phiên riêng để xem trạng thái OTA (board khởi động lại thì đăng nhập lại)
            var until = DateTime.UtcNow.AddMinutes(minutes);
            while (DateTime.UtcNow < until)
            {
                var lease = _lease == null ? "-" : string.Join(",", _lease.Status.Select(kv => kv.Key + "=" + kv.Value));
                string ota;
                try
                {
                    probe ??= (await RemoteClient.ConnectMcuAsync(host, 443, Identity(), _ => false)).Item1;
                    var st = await probe.OtaStateAsync();
                    ota = $"ver={St(st, "Version")} lease={St(st, "Lease")} approved={St(st, "Approved")} by={St(st, "ApprovedBy")} pending={St(st, "PendingVerify")}";
                }
                catch (RemoteException e) { ota = "board: " + e.Code; probe?.Dispose(); probe = null; }
                var line = $"lease[{lease}] {ota}";
                File.WriteAllText(Path.Combine(outDir, "status.txt"), $"{DateTime.UtcNow.AddHours(7):HH:mm:ss} {line}");
                if (line != last) { Ev(line); last = line; }
                var cmd = Path.Combine(outDir, "cmd.txt");
                if (File.Exists(cmd)) { var c = File.ReadAllText(cmd).Trim(); File.Delete(cmd); Ev("lệnh: " + c); if (c == "quit") break; }
                await Task.Delay(5000);
            }
        }
        catch (Exception e) { Ev("LỖI " + e); }
        finally
        {
            await StopAsync();
            if (_lease != null) await _lease.StopAsync();   // trả lease: board về độc lập, tự nối cloud lại
            Ev("kết thúc");
            Application.Exit();
        }
    }

    static string St(JsonElement e, string k) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(k, out var v) ? v.ToString() : "";
}
