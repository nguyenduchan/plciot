using System.Text.Json;
using Plciot.Scada;
using Plciot.Scada.Services;

namespace GatewayApp;

/// <summary>
/// Kiểm thử chương trình logic của GATEWAY PC NẠP QUA INTERNET (bản Debug) — đúng đường thật:
///   GatewayAdmin đề xuất (text) → chủ trạm duyệt trên webapp → server gửi rpc PUT /api/offline (kèm mã duyệt) qua MQTT → gateway áp dụng → TỰ THỰC THI.
///   GATEWAYAPP_SETTINGS=&lt;BẢN SAO cấu hình gateway đã ghép cloud&gt; GatewayApp.exe --pccloudlogictest THƯ_MỤC --noauth [--plc-port 15021]
/// PLC: Modbus TCP giả trong tiến trình (pump1.run D51 ghi được, pump1.ok D56 chỉ đọc). Cloud: giữ nguyên thông số của bản sao (nối VPS thật).
/// Bài thử KHÔNG tự đổi logic: chờ chương trình tới qua cloud, ghi trạng thái mỗi giây vào status.txt và mọi lần pump1.run đổi vào events.txt.
/// Điều khiển từ ngoài bằng file cmd.txt (mỗi lần một lệnh, đọc xong xoá):
///   cloud-down  trỏ cloud vào địa chỉ không có broker rồi chạy lại gateway → MẤT MẠNG THẬT (logic phải tự chạy tiếp)
///   cloud-up    trả lại thông số cloud, chạy lại gateway
///   set D56=1   đổi thanh ghi PLC (như cảm biến)
///   quit        dừng, trả lại thông số cloud, thoát
/// </summary>
public sealed partial class MainForm
{
    public async Task PcCloudLogicTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var events = Path.Combine(outDir, "events.txt");
        void Ev(string s) { lock (outDir) File.AppendAllText(events, $"{DateTime.UtcNow.AddHours(7):HH:mm:ss} {s}{Environment.NewLine}"); }
        var port = int.TryParse(ArgValue(RunOptions.Args, "--plc-port"), out var pp) ? pp : 15021;
        var plc = new MiniModbusSlave(port);
        string cloudHost = _cfg.CloudHost; int cloudPort = _cfg.CloudPort;
        try
        {
            plc.Start();
            await StopAsync();
            PackMap P(string c, string f, int d, PackAccess a) => new() { Child = c, Field = f, MqttKey = f, Address = d, Protocol = "ModbusTcp", Access = a, Params = new() { ["unit"] = "1" } };
            _cfg.Source = PlcSource.ModbusTcp; _cfg.PlcHost = "127.0.0.1"; _cfg.PlcPort = port; _cfg.PollMs = 300;
            _cfg.Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = port } };
            _cfg.Pack = new() { P("pump1", "run", 51, PackAccess.ReadWrite), P("pump1", "ok", 56, PackAccess.Read) };
            plc.Reg[56] = 1;
            await StartAsync();
            Ev($"gateway {_cfg.Site}/{_cfg.Device} chạy, cloud {cloudHost}:{cloudPort}, logic rev {_host?.Core.Logic.Rev}");
            int lastRun = -1; uint lastRev = _host?.Core.Logic.Rev ?? 0; string lastCloud = "";
            var until = DateTime.UtcNow.AddMinutes(60);
            while (DateTime.UtcNow < until)
            {
                var h = _host;
                var run = plc.Reg[51] != 0 ? 1 : 0;
                if (run != lastRun) { Ev($"pump1.run = {run} (D51 trên PLC)"); lastRun = run; }
                var cloud = h?.Cloud.ToString() ?? "stopped";
                if (cloud != lastCloud) { Ev($"cloud: {cloud}"); lastCloud = cloud; }
                var rev = h?.Core.Logic.Rev ?? lastRev;
                if (rev != lastRev) { Ev($"logic rev {lastRev} → {rev}: {JsonSerializer.Serialize(h!.Core.Logic.Program, GatewayLogic.Json)}"); lastRev = rev; }
                File.WriteAllText(Path.Combine(outDir, "status.txt"),
                    $"{DateTime.UtcNow.AddHours(7):HH:mm:ss} cloud={cloud} rev={rev} D51={plc.Reg[51]} D56={plc.Reg[56]}\n{(h == null ? "" : JsonSerializer.Serialize(h.Core.Logic.Status(), GatewayLogic.Json))}");
                var cmdFile = Path.Combine(outDir, "cmd.txt");
                if (File.Exists(cmdFile))
                {
                    var cmd = File.ReadAllText(cmdFile).Trim(); File.Delete(cmdFile);
                    Ev("lệnh: " + cmd);
                    if (cmd == "quit") break;
                    if (cmd == "cloud-down") { await StopAsync(); _cfg.CloudHost = "127.0.0.1"; _cfg.CloudPort = 1; await StartAsync(); }
                    else if (cmd == "cloud-up") { await StopAsync(); _cfg.CloudHost = cloudHost; _cfg.CloudPort = cloudPort; await StartAsync(); }
                    else if (cmd.StartsWith("set D") && cmd.Contains('='))
                    {
                        var kv = cmd[5..].Split('=');
                        plc.Reg[int.Parse(kv[0])] = ushort.Parse(kv[1]);
                    }
                }
                await Task.Delay(500);
            }
        }
        catch (Exception e) { Ev("LỖI " + e); }
        finally
        {
            await StopAsync();
            _cfg.CloudHost = cloudHost; _cfg.CloudPort = cloudPort;
            try { SaveCfg(); } catch (IOException) { }
            plc.Stop();
            Ev("kết thúc");
            Application.Exit();
        }
    }
}
