using Plciot.Scada;
using Plciot.Scada.Services.Ui;

namespace GatewayApp;

/// <summary>
/// Giữ LEASE chế độ gateway trên các board Waveshare mà gateway PC này đọc bằng Modbus TCP.
/// Một kết nối Modbus TCP có địa chỉ trùng board đã tin cậy (đã ghép bằng "Kết nối Waveshare") → mỗi vài giây gửi nhịp tim POST /api/lease qua HTTPS đã xác thực.
/// Board có lease: dừng MQTTS lên cloud (gateway PC này là đường báo duy nhất) và mở Modbus TCP slave cho IP của PC này (Unit 0 = DI/DO board,
/// Unit n = cầu RS485 do board làm master). Gateway dừng / mất mạng quá hạn lease → board tự về chế độ độc lập.
/// </summary>
public sealed class BoardLease : IDisposable
{
    public const int TtlSec = 15, BeatMs = 5000;
    readonly Func<ScadaConfig> _cfg; readonly Func<bool> _running; readonly GatewayIdentity _id;
    readonly Dictionary<string, RemoteClient> _clients = new();
    readonly CancellationTokenSource _cts = new();
    /// <summary>host → "gateway" (đang giữ lease) | mã lỗi gần nhất.</summary>
    public Dictionary<string, string> Status { get; } = new();
    public int ApiPort { get; set; } = 443;   // kiểm thử trên bản giả lập đổi cổng
    /// <summary>Cập nhật firmware board đang là slave (không tự lên cloud) qua LAN — null = không tự cập nhật.</summary>
    public BoardOtaRelay? Ota { get; set; }
    /// <summary>Giữ giờ cho board slave (không nhận giờ server): đặt theo đồng hồ PC khi board chưa có giờ / lệch.</summary>
    public BoardTimeSync? Time { get; set; }

    public BoardLease(Func<ScadaConfig> cfg, Func<bool> running, GatewayIdentity id) { _cfg = cfg; _running = running; _id = id; }

    public void Start() => _ = Task.Run(LoopAsync);

    async Task LoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            try { await TickAsync(); } catch (Exception) { }
            try { await Task.Delay(BeatMs, _cts.Token); } catch (OperationCanceledException) { break; }
        }
        await ReleaseAllAsync();
    }

    /// <summary>Các board cần giữ lease: kết nối Modbus TCP trùng IP board đã tin cậy; chỉ khi gateway đang chạy.</summary>
    List<string> Targets()
    {
        if (!_running()) return new();
        var trusted = TrustedBoards.Hosts();
        return _cfg().Connections.Where(c => c.Protocol == PlcSource.ModbusTcp && c.Host.Length > 0 && trusted.Contains(c.Host.Trim()) && !TrustedBoards.IsStandalone(c.Host.Trim())).Select(c => c.Host.Trim()).Distinct().ToList();
    }

    /// <summary>
    /// Thời gian tối thiểu giữa hai lần đổi trạng thái DO1..DO8 của board (I/O board = Unit 0 qua Modbus TCP: D20..D27 / coil 0..7) theo các field đầu ra
    /// đã khai báo (<see cref="PackMap.MinToggleMs"/>). Gửi kèm mỗi nhịp lease: firmware chặn lần cuối, kể cả khi lệnh Modbus không qua lõi gateway.
    /// </summary>
    public static int[] DoMinMs(ScadaConfig cfg)
    {
        var r = new int[8];
        foreach (var p in cfg.Pack.Where(p => p.Source == PlcSource.ModbusTcp && p.Param("unit") == "0" && p.Access != PackAccess.Read && p.MinToggleMs > 0))
            if (p.Address is >= 20 and <= 27) r[p.Address - 20] = Math.Max(r[p.Address - 20], p.MinToggleMs);
            else if (p.Address == 1) for (var i = 0; i < 8; i++) r[i] = Math.Max(r[i], p.MinToggleMs);   // D1 = cả 8 DO
        return r;
    }

    public async Task TickAsync()
    {
        var want = Targets();
        foreach (var h in _clients.Keys.Where(h => !want.Contains(h)).ToList()) await ReleaseAsync(h);   // gateway dừng / bỏ kết nối: trả lease để board về độc lập ngay
        foreach (var h in want)
        {
            try
            {
                if (!_clients.TryGetValue(h, out var c))
                {
                    (c, _) = await RemoteClient.ConnectMcuAsync(h, ApiPort, _id, _ => false);   // không hỏi người dùng: chỉ board đã tin cậy
                    _clients[h] = c;
                }
                var r = await c.LeaseAsync(true, TtlSec, DoMinMs(_cfg()));
                Status[h] = r.Mode == "gateway" ? "gateway" : "độc lập";
                if (r.Mode == "gateway" && Ota != null) await Ota.TickAsync(h, c);   // board không tự lên cloud: gateway PC lo cập nhật firmware qua LAN
                if (r.Mode == "gateway" && Time != null) await Time.TickAsync(h, c); // … và giữ giờ cho board (hẹn giờ cần giờ tin được)
            }
            catch (RemoteException e)
            {
                Status[h] = e.Code;
                if (_clients.Remove(h, out var bad)) bad.Dispose();   // phiên hỏng: lần sau đăng nhập lại
            }
        }
    }

    async Task ReleaseAsync(string h)
    {
        if (_clients.Remove(h, out var c))
        {
            try { await c.LeaseAsync(false); } catch (RemoteException) { }
            c.Dispose();
        }
        Status.Remove(h);
    }

    async Task ReleaseAllAsync() { foreach (var h in _clients.Keys.ToList()) await ReleaseAsync(h); }

    /// <summary>Trả lease ngay (đóng app): board về chế độ độc lập mà không phải chờ hết hạn.</summary>
    public async Task StopAsync() { _cts.Cancel(); await ReleaseAllAsync(); }

    public void Dispose() { _cts.Cancel(); }
}
