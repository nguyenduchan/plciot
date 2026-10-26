using Opc.Ua;
using Opc.Ua.Client;

namespace Plciot.Scada;

/// <summary>
/// OPC UA client: đọc mảng UInt16[300] (OpcUaImageNode); ghi từng thanh ghi vào nút theo mẫu OpcUaWriteNode ({a} = số D).
/// </summary>
public sealed class OpcUaDriver : IRegisterDriver
{
    readonly ScadaConfig _cfg;
    readonly SemaphoreSlim _lock = new(1, 1);
    ApplicationConfiguration? _app;
    ISession? _session;

    public OpcUaDriver(ScadaConfig cfg) { _cfg = cfg; }

    async Task<ISession> SessionAsync(CancellationToken ct)
    {
        if (_session is { Connected: true }) return _session;
        _session?.Dispose(); _session = null;
        _app ??= await OpcUaSupport.CreateAsync("PlciotScadaClient", false, null, _cfg.OpcUaAcceptUntrusted);
        var ep = CoreClientUtils.SelectEndpoint(_app, _cfg.OpcUaEndpoint, _cfg.OpcUaSecurity, 5000);
        var configured = new ConfiguredEndpoint(null, ep, EndpointConfiguration.Create(_app));
        _session = await Session.Create(_app, configured, false, "PlciotScada", 60000, new UserIdentity(), null, ct);
        return _session;
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var s = await SessionAsync(ct);
            var dv = await Task.Run(() => s.ReadValue(NodeId.Parse(_cfg.OpcUaImageNode)), ct);
            if (StatusCode.IsBad(dv.StatusCode)) throw new IOException($"opcua_{dv.StatusCode}");
            var arr = dv.Value as ushort[] ?? (dv.Value as short[])?.Select(v => unchecked((ushort)v)).ToArray()
                      ?? (dv.Value as int[])?.Select(v => (ushort)v).ToArray() ?? throw new IOException("opcua_not_array");
            if (arr.Length < address + count) throw new IOException("opcua_short_array");
            return arr[address..(address + count)];
        }
        catch { _session?.Dispose(); _session = null; throw; }
        finally { _lock.Release(); }
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var s = await SessionAsync(ct);
            var node = NodeId.Parse(_cfg.OpcUaWriteNode.Replace("{a}", address.ToString()));
            var req = new WriteValueCollection { new WriteValue { NodeId = node, AttributeId = Attributes.Value, Value = new DataValue(new Variant(value)) } };
            var resp = await s.WriteAsync(null, req, ct);
            if (StatusCode.IsBad(resp.Results[0])) throw new IOException($"opcua_write_{resp.Results[0]}");
        }
        catch { _session?.Dispose(); _session = null; throw; }
        finally { _lock.Release(); }
    }

    public void Dispose() { _session?.Dispose(); _lock.Dispose(); }
}
