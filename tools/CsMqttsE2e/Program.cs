using System.Text;
using System.Text.Json;
using Plciot.Scada;

// Chạy CloudBridge thật (cùng stack C# app) → VPS mqtts, chờ 1 lệnh cmd rồi thoát.
//   dotnet run --project tools/CsMqttsE2e
var cfgPath = args.FirstOrDefault() ?? Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "PlciotScada", "conveyor", "config.json");

var cfg = ConfigStore.Load(cfgPath);
cfg.Mobile = MobileAccess.MonitorOnly;
if (string.IsNullOrWhiteSpace(cfg.CloudHost)) { Console.Error.WriteLine("Thiếu CloudHost"); return 1; }
if (string.IsNullOrWhiteSpace(cfg.CloudPassword)) { Console.Error.WriteLine("Thiếu CloudPassword"); return 1; }

Console.WriteLine($"Config {cfgPath}");
Console.WriteLine($"Cloud {cfg.CloudTransport}://{cfg.CloudHost}:{cfg.CloudPort} site={cfg.Site}/{cfg.Device} user={cfg.CloudUser}");

using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
await using var bridge = new CloudBridge(cfg);
var cmdTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
bridge.Log += m => Console.WriteLine("[cloud] " + m);
bridge.StateChanged += s => Console.WriteLine("[state] " + s);
bridge.CommandReceived += payload =>
{
    var s = Encoding.UTF8.GetString(payload);
    Console.WriteLine("[cmd] " + s);
    cmdTcs.TrySetResult(s);
    return Task.CompletedTask;
};

var run = bridge.RunAsync(cts.Token);

// Chờ nối xong
for (var i = 0; i < 50 && bridge.State != CloudState.Connected; i++)
    await Task.Delay(200, cts.Token);
if (bridge.State != CloudState.Connected)
{
    Console.Error.WriteLine("Không nối được cloud: " + bridge.State);
    return 2;
}

var mark = "csharp-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
var regs = Enumerable.Range(0, 40).Select(i => (ushort)(i == 6 ? 1 : i == 7 ? 99 : i == 14 ? 3 : 0)).ToArray();
var tele = JsonSerializer.Serialize(new { schema = 1, r = regs, mark });
bridge.Forward(cfg.BaseTopic + "/status", Encoding.ASCII.GetBytes("online"), true);
bridge.Forward(cfg.BaseTopic + "/telemetry", Encoding.UTF8.GetBytes(tele), true);
Console.WriteLine($"Published telemetry mark={mark} topic={cfg.BaseTopic}/telemetry");

// Báo mark ra stdout để script ngoài gửi cmd
Console.WriteLine("MARK=" + mark);
Console.WriteLine("BASE=" + cfg.BaseTopic);
Console.WriteLine("WAITING_CMD");

var finished = await Task.WhenAny(cmdTcs.Task, Task.Delay(25000, cts.Token));
if (finished != cmdTcs.Task)
{
    Console.Error.WriteLine("TIMEOUT: không nhận cmd");
    cts.Cancel();
    try { await run; } catch { /* ignore */ }
    return 3;
}

var cmd = await cmdTcs.Task;
await bridge.PublishAckAsync(JsonSerializer.Serialize(new { id = mark, ok = true }));
Console.WriteLine("ACK sent for " + mark);
cts.Cancel();
try { await run; } catch (OperationCanceledException) { }
Console.WriteLine("PASS csharp CloudBridge roundtrip");
return 0;
