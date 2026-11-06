using Opc.Ua;
using Opc.Ua.Configuration;
using Opc.Ua.Server;

namespace PlcSim.Protocols;

/// <summary>
/// OPC UA server ghi được: mảng UInt16[300] "PLC_D" (gateway đọc ảnh), các biến "PLC_W{a}" (gateway ghi từng thanh ghi),
/// và biến Double "d.&lt;child&gt;.&lt;field&gt;" cho thiết bị con. Chấp nhận ẩn danh; security None + Basic256Sha256.
/// </summary>
public sealed class OpcUaPlcServer : IEndpoint
{
    readonly PlcModel _m;
    readonly string _bind;
    readonly int _port;
    readonly Action<string> _log;
    PlcOpcServer? _server;
    int _sessions;

    public string Name => "OPC UA";
    public int Peers => _sessions;
    public string Endpoint { get; private set; } = "";

    public OpcUaPlcServer(PlcModel m, string bind, int port, Action<string> log)
    {
        _m = m; _bind = bind; _port = port; _log = log;
    }

    public async Task StartAsync()
    {
        var pki = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PlcSim", "pki");
        string Cert(string s) => Path.Combine(pki, s);
        Endpoint = $"opc.tcp://{(_bind == "0.0.0.0" ? "localhost" : _bind)}:{_port}/plcsim";
        var cfg = new Opc.Ua.ApplicationConfiguration
        {
            ApplicationName = "PlcSim",
            ApplicationUri = $"urn:{Environment.MachineName}:PlcSim",
            ProductUri = "urn:plciot:plcsim",
            ApplicationType = ApplicationType.Server,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier { StoreType = "Directory", StorePath = Cert("own"), SubjectName = "CN=PlcSim, O=Plciot" },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = "Directory", StorePath = Cert("issuer") },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = "Directory", StorePath = Cert("trusted") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = "Directory", StorePath = Cert("rejected") },
                AutoAcceptUntrustedCertificates = true,
                AddAppCertToTrustedStore = true,
                MinimumCertificateKeySize = 2048,
            },
            TransportQuotas = new TransportQuotas { OperationTimeout = 15000, MaxArrayLength = 65535, MaxMessageSize = 4 << 20 },
            ServerConfiguration = new ServerConfiguration
            {
                BaseAddresses = { $"opc.tcp://{_bind}:{_port}/plcsim" },
                SecurityPolicies =
                {
                    new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None },
                    new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.SignAndEncrypt, SecurityPolicyUri = SecurityPolicies.Basic256Sha256 },
                },
                UserTokenPolicies = { new UserTokenPolicy(UserTokenType.Anonymous) },
                MaxSessionCount = 10,
            },
            TraceConfiguration = new TraceConfiguration(),
        };
        await cfg.Validate(ApplicationType.Server);
        var app = new ApplicationInstance(cfg) { ApplicationName = "PlcSim", ApplicationType = ApplicationType.Server };
        if (!await app.CheckApplicationInstanceCertificate(true, 0)) throw new InvalidOperationException("Không tạo được chứng chỉ OPC UA");
        _server = new PlcOpcServer(_m, _log);
        await app.Start(_server);
        _server.Manager?.Refresh();
        _server.CurrentInstance.SessionManager.SessionCreated += (_, _) => { Interlocked.Increment(ref _sessions); _log("OPC UA: gateway tạo session"); };
        _server.CurrentInstance.SessionManager.SessionClosing += (_, _) => { Interlocked.Decrement(ref _sessions); _log("OPC UA: gateway đóng session"); };
        _log($"OPC UA server nghe {Endpoint}  (đọc ns=2;s=PLC_D, ghi ns=2;s=PLC_W<a>)");
    }

    public Task PushAsync() { _server?.Manager?.Refresh(); _log("OPC UA: node đã cập nhật, chờ gateway đọc"); return Task.CompletedTask; }

    public ValueTask DisposeAsync()
    {
        if (_server != null) { try { _server.Stop(); } catch { /* ignore */ } _server.Dispose(); }
        return ValueTask.CompletedTask;
    }
}

sealed class PlcOpcServer : StandardServer
{
    readonly PlcModel _m;
    readonly Action<string> _log;
    public PlcNodeManager? Manager { get; private set; }
    public PlcOpcServer(PlcModel m, Action<string> log) { _m = m; _log = log; }

    protected override MasterNodeManager CreateMasterNodeManager(IServerInternal server, Opc.Ua.ApplicationConfiguration configuration)
    {
        Manager = new PlcNodeManager(server, configuration, _m, _log);
        return new MasterNodeManager(server, configuration, null, Manager);
    }

    protected override ServerProperties LoadServerProperties() => new()
    {
        ManufacturerName = "Plciot", ProductName = "PlcSim", ProductUri = "urn:plciot:plcsim", SoftwareVersion = "1.0",
        BuildNumber = "1", BuildDate = DateTime.UtcNow,
    };
}

sealed class PlcNodeManager : CustomNodeManager2
{
    readonly PlcModel _m;
    readonly Action<string> _log;
    FolderState? _folder;
    BaseDataVariableState? _image;
    readonly BaseDataVariableState[] _w = new BaseDataVariableState[PlcModel.Size];
    readonly Dictionary<string, BaseDataVariableState> _fieldVars = new();

    public PlcNodeManager(IServerInternal server, Opc.Ua.ApplicationConfiguration config, PlcModel m, Action<string> log)
        : base(server, config, "urn:plciot:plcsim")
    {
        _m = m; _log = log;
        SystemContext.NodeIdFactory = this;
    }

    public override void CreateAddressSpace(IDictionary<NodeId, IList<IReference>> externalReferences)
    {
        lock (Lock)
        {
            if (!externalReferences.TryGetValue(ObjectIds.ObjectsFolder, out var refs))
                externalReferences[ObjectIds.ObjectsFolder] = refs = new List<IReference>();
            _folder = new FolderState(null)
            {
                SymbolicName = "PLC", ReferenceTypeId = ReferenceTypes.Organizes, TypeDefinitionId = ObjectTypeIds.FolderType,
                NodeId = new NodeId("PLC", NamespaceIndex), BrowseName = new QualifiedName("PLC", NamespaceIndex),
                DisplayName = new LocalizedText("en", "PLC"), EventNotifier = EventNotifiers.None,
            };
            _folder.AddReference(ReferenceTypes.Organizes, true, ObjectIds.ObjectsFolder);
            refs.Add(new NodeStateReference(ReferenceTypes.Organizes, false, _folder.NodeId));
            AddPredefinedNode(SystemContext, _folder);

            _image = Var("PLC_D", DataTypeIds.UInt16, ValueRanks.OneDimension, false);
            for (var a = 0; a < PlcModel.Size; a++)
            {
                var v = _w[a] = Var($"PLC_W{a}", DataTypeIds.UInt16, ValueRanks.Scalar, true);
                v.Value = _m.Get(a);
                var addr = a;
                v.OnSimpleWriteValue = (ISystemContext ctx, NodeState node, ref object value) =>
                {
                    ushort u;
                    try { u = Convert.ToUInt16(value); } catch { return StatusCodes.BadTypeMismatch; }
                    _log($"OPC UA nhận lệnh ghi: D{addr} = {u}");
                    _m.Set(addr, u, "gateway");
                    return ServiceResult.Good;
                };
            }
        }
    }

    BaseDataVariableState Var(string id, NodeId type, int rank, bool writable)
    {
        var access = writable ? AccessLevels.CurrentReadOrWrite : AccessLevels.CurrentRead;
        var v = new BaseDataVariableState(_folder)
        {
            SymbolicName = id, ReferenceTypeId = ReferenceTypes.Organizes, TypeDefinitionId = VariableTypeIds.BaseDataVariableType,
            NodeId = new NodeId(id, NamespaceIndex), BrowseName = new QualifiedName(id, NamespaceIndex), DisplayName = new LocalizedText("en", id),
            DataType = type, ValueRank = rank, AccessLevel = access, UserAccessLevel = access, Historizing = false,
            StatusCode = StatusCodes.Good, Timestamp = DateTime.UtcNow,
        };
        if (rank == ValueRanks.OneDimension)
        {
            v.ArrayDimensions = new ReadOnlyList<uint>(new List<uint> { (uint)PlcModel.Size });
            v.Value = new ushort[PlcModel.Size];
        }
        else v.Value = type == DataTypeIds.Double ? 0.0 : (ushort)0;
        _folder!.AddChild(v);
        AddPredefinedNode(SystemContext, v);
        return v;
    }

    public override void Read(OperationContext context, double maxAge, IList<ReadValueId> nodesToRead, IList<DataValue> values, IList<ServiceResult> errors)
    {
        Refresh();
        base.Read(context, maxAge, nodesToRead, values, errors);
    }

    public void Refresh()
    {
        lock (Lock)
        {
            if (_image == null) return;
            var all = _m.Read(0, PlcModel.Size);
            _image.Value = all; _image.Timestamp = DateTime.UtcNow; _image.ClearChangeMasks(SystemContext, false);
            for (var a = 0; a < PlcModel.Size; a++) { _w[a].Value = all[a]; _w[a].Timestamp = DateTime.UtcNow; }
            foreach (var (c, f, val) in _m.Fields())
            {
                var key = $"d.{c}.{f}";
                if (!_fieldVars.TryGetValue(key, out var v))
                {
                    v = Var(key, DataTypeIds.Double, ValueRanks.Scalar, true);
                    var child = c; var field = f;
                    v.OnSimpleWriteValue = (ISystemContext ctx, NodeState node, ref object value) =>
                    {
                        try { _m.SetField(child, field, Convert.ToDouble(value), "gateway"); } catch { return StatusCodes.BadTypeMismatch; }
                        return ServiceResult.Good;
                    };
                    _fieldVars[key] = v;
                }
                v.Value = val; v.Timestamp = DateTime.UtcNow; v.ClearChangeMasks(SystemContext, false);
            }
        }
    }
}
