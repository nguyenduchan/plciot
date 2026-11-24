using System.Net.Sockets;

namespace GatewayApp;

/// <summary>
/// Quét đầu ra DO1..DO8 của board Waveshare THẬT (--lansweep KQ.txt --lan-target IP:443 [--sweep-ms 2500]): xin lease, nối Modbus TCP cổng 502 (Unit 0),
/// bật lần lượt từng DO bằng coil FC05 rồi tắt, ghi trạng thái board báo lại (FC01) — để người đứng cạnh board xem LED/tải nào sáng và so với DOn.
/// </summary>
public sealed partial class MainForm
{
    public async Task LanSweepAsync(string result)
    {
        var args = Environment.GetCommandLineArgs();
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var ms = int.TryParse(ArgValue(args, "--sweep-ms"), out var m) ? m : 2500;
        var lines = new List<string>();
        RemoteClient? c = null;
        try
        {
            c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var lease = await c.LeaseAsync(true, 120);
            lines.Add($"INFO lease mode={lease.Mode} ok={lease.Ok}");
            ushort tid = 1;
            async Task<byte[]> Call(byte[] pdu)   // một kết nối cho mỗi lệnh: DO giữ nguyên trên board giữa các lệnh
            {
                using var tcp = new TcpClient(); await tcp.ConnectAsync(host, 502);
                var ns = tcp.GetStream();
                var f = new byte[7 + pdu.Length];
                f[0] = (byte)(tid >> 8); f[1] = (byte)tid; tid++; f[4] = (byte)((pdu.Length + 1) >> 8); f[5] = (byte)(pdu.Length + 1); f[6] = 0;
                Array.Copy(pdu, 0, f, 7, pdu.Length);
                await ns.WriteAsync(f);
                var h = new byte[7]; var got = 0;
                while (got < 7) got += await ns.ReadAsync(h.AsMemory(got));
                var body = new byte[((h[4] << 8) | h[5]) - 1]; got = 0;
                while (got < body.Length) got += await ns.ReadAsync(body.AsMemory(got));
                return body;
            }
            async Task<int> Mask() { var r = await Call(new byte[] { 1, 0, 0, 0, 8 }); return r.Length >= 3 ? r[2] : -1; }
            async Task Coil(int ch, bool on) { await Call(new byte[] { 5, 0, (byte)ch, (byte)(on ? 0xFF : 0), 0 }); }
            lines.Add($"INFO nghỉ: mask board báo = 0x{await Mask():X2}");
            for (var ch = 0; ch < 8; ch++)
            {
                await Coil(ch, true);
                lines.Add($"STEP DO{ch + 1} = BẬT → mask board báo 0x{await Mask():X2}");
                File.WriteAllLines(result, lines);
                await Task.Delay(ms);
                await Coil(ch, false);
                await Task.Delay(300);
            }
            lines.Add($"INFO xong: mask board báo = 0x{await Mask():X2}");
            await c.LeaseAsync(false);
            lines.Add("PASS quét xong");
        }
        catch (Exception e) { lines.Add("FAIL " + RemoteClient.Explain(e) + " | " + e.GetType().Name + ": " + e.Message); }
        finally { c?.Dispose(); }
        File.WriteAllLines(result, lines);
        Close();
    }
}
