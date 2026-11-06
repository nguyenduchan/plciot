using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>
/// Siemens S7 (ISO-on-TCP, S7comm): COTP connect, setup communication, đọc/ghi byte (function 0x04/0x05).
/// Thanh ghi D n = DBW(2n) của MỌI data block (big-endian), khớp driver S7 của gateway.
/// </summary>
public sealed class S7Server : IEndpoint
{
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    int _peers;

    public string Name => "Siemens S7";
    public int Peers => _peers;

    public S7Server(PlcModel m, string bind, int port, Action<string> log)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _log = log;
    }

    public Task StartAsync()
    {
        _l = new TcpListener(_bind, _port);
        _l.Start();
        _log($"S7 server nghe {_bind}:{_port} (DB bất kỳ, DBW(2n) = D n)");
        _ = Task.Run(async () =>
        {
            try { while (!_cts.IsCancellationRequested) { var c = await _l.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => Serve(c)); } }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _log($"S7 accept: {ex.Message}"); }
        });
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("S7: dữ liệu đã cập nhật vào DB, chờ gateway poll"); return Task.CompletedTask; }

    async Task Serve(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        _log($"S7: gateway {who} kết nối");
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var h = new byte[4];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, h, _cts.Token)) return;
                if (h[0] != 3) return;
                var len = BinaryPrimitives.ReadUInt16BigEndian(h.AsSpan(2));
                if (len < 7 || len > 4096) return;
                var body = new byte[len - 4];
                if (!await Io.ReadExact(ns, body, _cts.Token)) return;
                var rsp = HandleTpkt(body);
                if (rsp == null) continue;
                var outp = new byte[4 + rsp.Length];
                outp[0] = 3; BinaryPrimitives.WriteUInt16BigEndian(outp.AsSpan(2), (ushort)outp.Length);
                rsp.CopyTo(outp, 4);
                await ns.WriteAsync(outp, _cts.Token);
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { Interlocked.Decrement(ref _peers); _log($"S7: gateway {who} ngắt"); }
    }

    /// <summary>body = COTP + S7. Trả phần sau TPKT của phản hồi.</summary>
    public byte[]? HandleTpkt(byte[] b)
    {
        if (b.Length < 2) return null;
        if (b[1] == 0xE0)                                   // COTP connection request → confirm (TSAP echo)
        {
            var tsaps = new List<byte>();
            for (var i = 7; i + 1 < b.Length;)              // tham số sau 6 byte cố định: C0 (TPDU size), C1/C2 (TSAP)
            {
                var code = b[i]; var pl = b[i + 1];
                if (i + 2 + pl > b.Length) break;
                if (code is 0xC0 or 0xC1 or 0xC2) { tsaps.Add(code); tsaps.Add(pl); tsaps.AddRange(b.AsSpan(i + 2, pl).ToArray()); }
                i += 2 + pl;
            }
            var cc = new List<byte> { 0x11 + 0, 0xD0, b[4], b[5], b[2], b[3], 0x00 };
            cc.AddRange(tsaps);
            cc[0] = (byte)(cc.Count - 1);
            return cc.ToArray();
        }
        if (b[1] != 0xF0 || b.Length < 3 + 10) return null;   // DT
        var s7 = b.AsSpan(3);
        if (s7[0] != 0x32 || s7[1] != 0x01) return null;
        var pduRef = s7.Slice(4, 2).ToArray();
        var paramLen = BinaryPrimitives.ReadUInt16BigEndian(s7.Slice(6, 2));
        var p = s7.Slice(10, paramLen);
        var data = s7[(10 + paramLen)..];
        var rspParam = new List<byte>();
        var rspData = new List<byte>();
        byte err = 0;

        switch (p[0])
        {
            case 0xF0:                                       // setup communication: giữ PDU 480
                rspParam.AddRange(new byte[] { 0xF0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xE0 });
                break;
            case 0x04:
            {
                var n = p[1];
                rspParam.AddRange(new byte[] { 0x04, n });
                for (var i = 0; i < n; i++)
                {
                    var (ok, off, cnt) = Item(p.Slice(2 + i * 12, 12));
                    if (!ok || off % 2 != 0 || cnt % 2 != 0 || !_m.InRange(off / 2, Math.Max(1, cnt / 2))) { rspData.AddRange(new byte[] { 0x05, 0x00, 0x00, 0x00 }); continue; }
                    var vals = _m.Read(off / 2, cnt / 2);
                    rspData.AddRange(new byte[] { 0xFF, 0x04, (byte)(cnt * 8 >> 8), (byte)(cnt * 8) });
                    foreach (var v in vals) { rspData.Add((byte)(v >> 8)); rspData.Add((byte)v); }
                    if (cnt % 2 != 0) rspData.Add(0);
                }
                break;
            }
            case 0x05:
            {
                var n = p[1];
                rspParam.AddRange(new byte[] { 0x05, n });
                var pos = 0;
                for (var i = 0; i < n; i++)
                {
                    var (ok, off, cnt) = Item(p.Slice(2 + i * 12, 12));
                    var bits = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(pos + 2, 2));
                    var bytes = bits / 8;
                    var d = data.Slice(pos + 4, bytes);
                    pos += 4 + bytes + (bytes % 2);
                    if (!ok || off % 2 != 0 || bytes % 2 != 0 || !_m.InRange(off / 2, Math.Max(1, bytes / 2))) { rspData.Add(0x05); continue; }
                    for (var k = 0; k < bytes / 2; k++)
                    {
                        var v = BinaryPrimitives.ReadUInt16BigEndian(d.Slice(k * 2, 2));
                        _log($"S7 nhận lệnh ghi: D{off / 2 + k} = {v}");
                        _m.Set(off / 2 + k, v, "gateway");
                    }
                    rspData.Add(0xFF);
                }
                break;
            }
            default: err = 0x81; break;
        }
        var resp = new List<byte> { 0x02, 0xF0, 0x80, 0x32, 0x03, 0x00, 0x00, pduRef[0], pduRef[1] };
        resp.Add((byte)(rspParam.Count >> 8)); resp.Add((byte)rspParam.Count);
        resp.Add((byte)(rspData.Count >> 8)); resp.Add((byte)rspData.Count);
        resp.Add(err); resp.Add(0);
        resp.AddRange(rspParam); resp.AddRange(rspData);
        return resp.ToArray();
    }

    /// <summary>Item S7ANY: 12 byte; chỉ nhận vùng DB (0x84) kiểu byte. offset = địa chỉ bit / 8.</summary>
    static (bool Ok, int Offset, int Count) Item(ReadOnlySpan<byte> s)
    {
        if (s[0] != 0x12 || s[3] != 0x02 || s[8] != 0x84) return (false, 0, 0);
        var cnt = BinaryPrimitives.ReadUInt16BigEndian(s.Slice(4, 2));
        var bitAddr = s[9] << 16 | s[10] << 8 | s[11];
        return (true, bitAddr / 8, cnt);
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        return ValueTask.CompletedTask;
    }
}
