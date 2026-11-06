using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace PlcSim.Protocols;

/// <summary>
/// Beckhoff ADS qua AMS/TCP: đóng vai CẢ router (cổng 48898: port connect, local NetId) lẫn PLC có symbol
/// ARRAY[0..299] OF INT (mặc định GVL_PLC.D). Hỗ trợ ReadWrite 0xF003 (lấy handle), Read/Write 0xF005 (theo handle), 0xF006 (xoá handle).
/// Dùng khi máy gateway KHÔNG cài TwinCAT (trùng cổng 48898 nếu có TwinCAT chạy sẵn).
/// </summary>
public sealed class BeckhoffAdsServer : IEndpoint
{
    const ushort CmdPortConnect = 0x1000, CmdGetLocalNetId = 0x1002, CmdAms = 0x0000;
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly string _symbol;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    int _peers;
    uint _nextHandle = 0x100;
    readonly Dictionary<uint, (int Word, int Count)> _handles = new();
    static readonly byte[] LocalNetId = { 127, 0, 0, 1, 2, 1 };

    public string Name => "Beckhoff ADS";
    public int Peers => _peers;

    public BeckhoffAdsServer(PlcModel m, string bind, int port, string symbol, Action<string> log)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _symbol = string.IsNullOrWhiteSpace(symbol) ? "GVL_PLC.D" : symbol.Trim(); _log = log;
    }

    public Task StartAsync()
    {
        _l = new TcpListener(_bind, _port);
        _l.Start();
        _log($"ADS (AMS router + PLC) nghe {_bind}:{_port}, symbol INT[300] \"{_symbol}\"");
        _ = Task.Run(async () =>
        {
            try { while (!_cts.IsCancellationRequested) { var c = await _l.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => Serve(c)); } }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _log($"ADS accept: {ex.Message}"); }
        });
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("ADS: dữ liệu đã cập nhật vào symbol, chờ gateway đọc"); return Task.CompletedTask; }

    async Task Serve(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var h = new byte[6];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, h, _cts.Token)) return;
                var cmd = BinaryPrimitives.ReadUInt16LittleEndian(h);
                var len = (int)BinaryPrimitives.ReadUInt32LittleEndian(h.AsSpan(2));
                if (len < 0 || len > 65536) return;
                var body = new byte[len];
                if (len > 0 && !await Io.ReadExact(ns, body, _cts.Token)) return;
                byte[]? rsp = cmd switch
                {
                    CmdPortConnect => Tcp(cmd, Concat(LocalNetId, BitConverter.GetBytes((ushort)32768))),
                    CmdGetLocalNetId => Tcp(cmd, LocalNetId),
                    CmdAms => Ams(body),
                    _ => null,
                };
                if (cmd == CmdPortConnect) _log($"ADS: gateway {who} kết nối router");
                if (rsp != null) await ns.WriteAsync(rsp, _cts.Token);
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { Interlocked.Decrement(ref _peers); }
    }

    static byte[] Concat(byte[] a, byte[] b) => a.Concat(b).ToArray();

    static byte[] Tcp(ushort cmd, byte[] data)
    {
        var r = new byte[6 + data.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(r, cmd);
        BinaryPrimitives.WriteUInt32LittleEndian(r.AsSpan(2), (uint)data.Length);
        data.CopyTo(r, 6);
        return r;
    }

    /// <summary>Gói AMS: header 32 byte + dữ liệu. Trả gói phản hồi đã bọc AMS/TCP.</summary>
    byte[]? Ams(byte[] b)
    {
        if (b.Length < 32) return null;
        var cmd = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(16));
        var d = b.AsSpan(32);
        if (Environment.GetEnvironmentVariable("PLCSIM_TRACE") == "1") _log($"ADS rx ams cmd={cmd} data={Convert.ToHexString(d.ToArray())}");
        byte[] data;
        uint result = 0;
        switch (cmd)
        {
            case 9:                                              // ReadWrite
            {
                var ig = BinaryPrimitives.ReadUInt32LittleEndian(d); var rl = BinaryPrimitives.ReadUInt32LittleEndian(d[8..]); var wl = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[12..]);
                var w = d.Slice(16, wl);
                if (ig == 0xF003)
                {
                    var name = Encoding.ASCII.GetString(w).TrimEnd('\0');
                    var (ok, word, cnt) = Resolve(name);
                    if (!ok) { _log($"ADS: symbol không tồn tại \"{name}\""); result = 0x710; data = Array.Empty<byte>(); break; }
                    uint hnd;
                    lock (_handles) { hnd = _nextHandle++; _handles[hnd] = (word, cnt); }
                    data = Concat(BitConverter.GetBytes(0u), BitConverter.GetBytes(4u)).Concat(BitConverter.GetBytes(hnd)).ToArray();
                    return Reply(b, 9, data);
                }
                result = 0x702; data = Array.Empty<byte>(); break;   // ADSERR_DEVICE_SRVNOTSUPP
            }
            case 2:                                              // Read
            {
                var ig = BinaryPrimitives.ReadUInt32LittleEndian(d); var io = BinaryPrimitives.ReadUInt32LittleEndian(d[4..]); var len = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[8..]);
                if (ig is 0xF00C or 0xF00F)                        // thông tin nạp bảng symbol: báo rỗng (0 symbol), client vẫn dùng handle theo tên
                {
                    var n0 = Math.Min(len, 64);
                    return Reply(b, 2, Concat(Concat(BitConverter.GetBytes(0u), BitConverter.GetBytes((uint)n0)), new byte[n0]));
                }
                if (ig == 0xF005 && TryHandle(io, out var hv))
                {
                    var words = _m.Read(hv.Word, hv.Count);
                    var bytes = new byte[hv.Count * 2];
                    for (var i = 0; i < hv.Count; i++) BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(i * 2), words[i]);
                    var n = Math.Min(len, bytes.Length);
                    return Reply(b, 2, Concat(Concat(BitConverter.GetBytes(0u), BitConverter.GetBytes((uint)n)), bytes[..n]));
                }
                result = 0x701; data = Array.Empty<byte>(); break;       // IG không hỗ trợ (vd. nạp bảng symbol)
            }
            case 3:                                              // Write
            {
                var ig = BinaryPrimitives.ReadUInt32LittleEndian(d); var io = BinaryPrimitives.ReadUInt32LittleEndian(d[4..]); var len = (int)BinaryPrimitives.ReadUInt32LittleEndian(d[8..]);
                var w = d.Slice(12, len);
                if (ig == 0xF006) { lock (_handles) _handles.Remove(BinaryPrimitives.ReadUInt32LittleEndian(w)); return Reply(b, 3, BitConverter.GetBytes(0u)); }
                if (ig == 0xF005 && TryHandle(io, out var hv))
                {
                    for (var i = 0; i < Math.Min(hv.Count, len / 2); i++)
                    {
                        var v = BinaryPrimitives.ReadUInt16LittleEndian(w.Slice(i * 2, 2));
                        _log($"ADS nhận lệnh ghi: D{hv.Word + i} = {v}");
                        _m.Set(hv.Word + i, v, "gateway");
                    }
                    return Reply(b, 3, BitConverter.GetBytes(0u));
                }
                result = 0x710; data = Array.Empty<byte>(); break;
            }
            case 4:                                              // ReadState: ADS state 5 (run), device state 0
                return Reply(b, 4, Concat(BitConverter.GetBytes(0u), new byte[] { 5, 0, 0, 0 }));
            case 1:                                              // ReadDeviceInfo
                return Reply(b, 1, Concat(Concat(BitConverter.GetBytes(0u), new byte[] { 3, 1, 0, 0 }), Encoding.ASCII.GetBytes("PlcSim".PadRight(16, '\0'))));
            default: result = 0x701; data = Array.Empty<byte>(); break;
        }
        _ = data;
        var errData = BitConverter.GetBytes(result);
        if (cmd is 2 or 9) errData = errData.Concat(BitConverter.GetBytes(0u)).ToArray();   // Read/ReadWrite: kèm length = 0
        return Reply(b, cmd, errData);
    }

    bool TryHandle(uint h, out (int Word, int Count) v)
    {
        lock (_handles) return _handles.TryGetValue(h, out v);
    }

    (bool Ok, int Word, int Count) Resolve(string name)
    {
        if (string.Equals(name, _symbol, StringComparison.OrdinalIgnoreCase)) return (true, 0, PlcModel.Size);
        if (name.StartsWith(_symbol + "[", StringComparison.OrdinalIgnoreCase) && name.EndsWith(']')
            && int.TryParse(name[(_symbol.Length + 1)..^1], out var idx) && _m.InRange(idx, 1)) return (true, idx, 1);
        return (false, 0, 0);
    }

    static byte[] Reply(byte[] req, ushort cmd, byte[] data)
    {
        var ams = new byte[32 + data.Length];
        req.AsSpan(8, 8).CopyTo(ams.AsSpan(0));                  // target = source của yêu cầu
        req.AsSpan(0, 8).CopyTo(ams.AsSpan(8));                  // source = target của yêu cầu
        BinaryPrimitives.WriteUInt16LittleEndian(ams.AsSpan(16), cmd);
        BinaryPrimitives.WriteUInt16LittleEndian(ams.AsSpan(18), 0x0005);   // response + ADS command
        BinaryPrimitives.WriteUInt32LittleEndian(ams.AsSpan(20), (uint)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(ams.AsSpan(24), 0);
        req.AsSpan(28, 4).CopyTo(ams.AsSpan(28));                // invoke id
        data.CopyTo(ams, 32);
        return Tcp(CmdAms, ams);
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        return ValueTask.CompletedTask;
    }
}
