using Opc.Ua;
using Opc.Ua.Configuration;
using Opc.Ua.Server;

namespace Plciot.Scada;

/// <summary>
/// OPC UA server CHỈ ĐỌC cho HMI/MES khác: thư mục "PLC" gồm các biến Status, Online, Inputs, Outputs, Alarms, Mode, RunRequest,
/// Target, Conveyor, Count, Total, RunSeconds, PumpStarts và mảng UInt16[300] "PLC_D" (cùng ảnh thanh ghi như Modbus server).
/// Chấp nhận ẩn danh (như luồng Node-RED) → chỉ mở trong LAN tin cậy. Không có biến nào ghi được.
/// </summary>
public sealed class OpcUaServerHost : IAsyncDisposable
{
    readonly ScadaConfig _cfg;
    readonly Func<(DeviceState.Snapshot State, ushort[] Image)> _source;
    readonly string? _pkiRoot;
    ScadaOpcServer? _server;
    ApplicationInstance? _app;
    Timer? _timer;

    public string Endpoint { get; private set; } = "";

    public OpcUaServerHost(ScadaConfig cfg, Func<(DeviceState.Snapshot State, ushort[] Image)> source, string? pkiRoot = null)
    {
        _cfg = cfg; _source = source; _pkiRoot = pkiRoot;
    }

    public async Task StartAsync()
    {
        var host = _cfg.ServerBind == "0.0.0.0" ? Environment.MachineName : _cfg.ServerBind;
        Endpoint = $"opc.tcp://{host}:{_cfg.OpcUaServerPort}/plciot";
        var cfg = await OpcUaSupport.CreateAsync("PlciotScadaServer", true, $"opc.tcp://{(_cfg.ServerBind == "0.0.0.0" ? "0.0.0.0" : _cfg.ServerBind)}:{_cfg.OpcUaServerPort}/plciot", true, _pkiRoot);
        _server = new ScadaOpcServer(_source);
        _app = new ApplicationInstance(cfg) { ApplicationName = "PlciotScadaServer", ApplicationType = ApplicationType.Server };
        await _app.Start(_server);
        // nạp ảnh ngay khi mở: nếu không, client nối sớm đọc phải toàn số 0 mà vẫn thấy "online"
        _server.Manager?.Refresh();
        _timer = new Timer(_ => _server.Manager?.Refresh(), null, 1000, 1000);
    }

    public async ValueTask DisposeAsync()
    {
        _timer?.Dispose();
        if (_server != null) { try { _server.Stop(); } catch { /* ignore */ } _server.Dispose(); }
    }
}

internal sealed class ScadaOpcServer : StandardServer
{
    readonly Func<(DeviceState.Snapshot State, ushort[] Image)> _source;
    public ScadaNodeManager? Manager { get; private set; }

    public ScadaOpcServer(Func<(DeviceState.Snapshot State, ushort[] Image)> source) { _source = source; }

    protected override MasterNodeManager CreateMasterNodeManager(IServerInternal server, ApplicationConfiguration configuration)
    {
        Manager = new ScadaNodeManager(server, configuration, _source);
        return new MasterNodeManager(server, configuration, null, Manager);
    }

    protected override ServerProperties LoadServerProperties() => new()
    {
        ManufacturerName = "Plciot", ProductName = "Plciot SCADA", ProductUri = "urn:plciot:scada", SoftwareVersion = "1.0",
        BuildNumber = "1", BuildDate = DateTime.UtcNow,
    };
}

internal sealed class ScadaNodeManager : CustomNodeManager2
{
    public const string Namespace = "urn:plciot:scada";
    readonly Func<(DeviceState.Snapshot State, ushort[] Image)> _source;
    readonly Dictionary<string, BaseDataVariableState> _vars = new();

    public ScadaNodeManager(IServerInternal server, ApplicationConfiguration config, Func<(DeviceState.Snapshot State, ushort[] Image)> source)
        : base(server, config, Namespace)
    {
        _source = source;
        SystemContext.NodeIdFactory = this;
    }

    public override void CreateAddressSpace(IDictionary<NodeId, IList<IReference>> externalReferences)
    {
        lock (Lock)
        {
            if (!externalReferences.TryGetValue(ObjectIds.ObjectsFolder, out var refs))
                externalReferences[ObjectIds.ObjectsFolder] = refs = new List<IReference>();

            var folder = new FolderState(null)
            {
                SymbolicName = "PLC", ReferenceTypeId = ReferenceTypes.Organizes, TypeDefinitionId = ObjectTypeIds.FolderType,
                NodeId = new NodeId("PLC", NamespaceIndex), BrowseName = new QualifiedName("PLC", NamespaceIndex),
                DisplayName = new LocalizedText("en", "PLC"), EventNotifier = EventNotifiers.None,
            };
            folder.AddReference(ReferenceTypes.Organizes, true, ObjectIds.ObjectsFolder);
            refs.Add(new NodeStateReference(ReferenceTypes.Organizes, false, folder.NodeId));
            AddPredefinedNode(SystemContext, folder);

            foreach (var (name, type) in new (string, NodeId)[]
            {
                ("Status", DataTypeIds.String), ("Online", DataTypeIds.Boolean), ("Inputs", DataTypeIds.Int32), ("Outputs", DataTypeIds.Int32),
                ("Alarms", DataTypeIds.Int32), ("Mode", DataTypeIds.Int32), ("RunRequest", DataTypeIds.Int32), ("Target", DataTypeIds.Int32),
                ("Conveyor", DataTypeIds.Int32), ("Count", DataTypeIds.Int32), ("Total", DataTypeIds.Int32), ("RunSeconds", DataTypeIds.Int32),
                ("PumpStarts", DataTypeIds.Int32),
            })
                _vars[name] = Variable(folder, $"PLC.{name}", name, type, ValueRanks.Scalar);

            // ảnh thanh ghi: ns=<n>;s=PLC_D — nút mà driver OPC UA client của cùng phần mềm đọc
            _vars["PLC_D"] = Variable(folder, "PLC_D", "PLC_D", DataTypeIds.UInt16, ValueRanks.OneDimension);
        }
    }

    BaseDataVariableState Variable(FolderState parent, string id, string name, NodeId dataType, int rank)
    {
        var v = new BaseDataVariableState(parent)
        {
            SymbolicName = name, ReferenceTypeId = ReferenceTypes.Organizes, TypeDefinitionId = VariableTypeIds.BaseDataVariableType,
            NodeId = new NodeId(id, NamespaceIndex), BrowseName = new QualifiedName(name, NamespaceIndex), DisplayName = new LocalizedText("en", name),
            WriteMask = AttributeWriteMask.None, UserWriteMask = AttributeWriteMask.None,
            DataType = dataType, ValueRank = rank, AccessLevel = AccessLevels.CurrentRead, UserAccessLevel = AccessLevels.CurrentRead,
            Historizing = false, StatusCode = StatusCodes.Good, Timestamp = DateTime.UtcNow,
        };
        if (rank == ValueRanks.OneDimension) { v.ArrayDimensions = new ReadOnlyList<uint>(new List<uint> { (uint)Contract.MaxRegister }); v.Value = new ushort[Contract.MaxRegister]; }
        else v.Value = dataType == DataTypeIds.String ? "offline" : dataType == DataTypeIds.Boolean ? false : (object)0;
        parent.AddChild(v);
        AddPredefinedNode(SystemContext, v);
        return v;
    }

    // làm tươi ảnh ngay trước mỗi lần client đọc: timer 1 s có thể chưa kịp chạy sau lần poll PLC đầu → client thấy "online" nhưng toàn số 0
    public override void Read(OperationContext context, double maxAge, IList<ReadValueId> nodesToRead, IList<DataValue> values, IList<ServiceResult> errors)
    {
        Refresh();
        base.Read(context, maxAge, nodesToRead, values, errors);
    }

    public void Refresh()
    {
        var (s, image) = _source();
        lock (Lock)
        {
            if (_vars.Count == 0) return;
            void Set(string n, object val)
            {
                var v = _vars[n];
                v.Value = val; v.Timestamp = DateTime.UtcNow; v.StatusCode = StatusCodes.Good;
                v.ClearChangeMasks(SystemContext, false);
            }
            Set("Status", s.Status);
            Set("Online", s.Fresh && s.Status == "online");
            Set("Inputs", s.Inputs); Set("Outputs", s.Outputs); Set("Alarms", s.Alarms); Set("Mode", s.Manual ? 1 : 0);
            Set("RunRequest", s.RunRequested ? 1 : 0); Set("Target", s.Target); Set("Conveyor", s.Conveyor);
            Set("Count", (int)s.Count); Set("Total", (int)s.Total); Set("RunSeconds", (int)s.RunSeconds); Set("PumpStarts", (int)s.PumpStarts);
            Set("PLC_D", image);
        }
    }
}
