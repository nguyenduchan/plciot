using Opc.Ua;
using Opc.Ua.Configuration;

namespace Plciot.Scada;

public static class OpcUaSupport
{
    static string PkiRoot(string name) =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlciotScada", "pki", name);

    public static async Task<ApplicationConfiguration> CreateAsync(string name, bool server, string? baseAddress, bool acceptUntrusted, string? pkiRoot = null)
    {
        var root = pkiRoot ?? PkiRoot(name);
        var app = new ApplicationInstance { ApplicationName = name, ApplicationType = server ? ApplicationType.Server : ApplicationType.Client };
        var cfg = new ApplicationConfiguration
        {
            ApplicationName = name,
            ApplicationUri = $"urn:{Environment.MachineName}:{name}",
            ProductUri = "urn:plciot:scada",
            ApplicationType = server ? ApplicationType.Server : ApplicationType.Client,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier { StoreType = "Directory", StorePath = Path.Combine(root, "own"), SubjectName = $"CN={name}, O=Plciot" },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = "Directory", StorePath = Path.Combine(root, "issuer") },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = "Directory", StorePath = Path.Combine(root, "trusted") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = "Directory", StorePath = Path.Combine(root, "rejected") },
                AutoAcceptUntrustedCertificates = acceptUntrusted,
                AddAppCertToTrustedStore = true,
                RejectSHA1SignedCertificates = true,
                MinimumCertificateKeySize = 2048,
            },
            TransportQuotas = new TransportQuotas { OperationTimeout = 15000, MaxStringLength = 1 << 20, MaxByteStringLength = 1 << 20, MaxArrayLength = 65535, MaxMessageSize = 4 << 20 },
            ClientConfiguration = new ClientConfiguration { DefaultSessionTimeout = 60000 },
            TraceConfiguration = new TraceConfiguration(),
        };
        if (server)
        {
            cfg.ServerConfiguration = new ServerConfiguration
            {
                BaseAddresses = { baseAddress! },
                SecurityPolicies =
                {
                    new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None },
                    new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.SignAndEncrypt, SecurityPolicyUri = SecurityPolicies.Basic256Sha256 },
                },
                UserTokenPolicies = { new UserTokenPolicy(UserTokenType.Anonymous) },
                MaxSessionCount = 10, MaxSubscriptionCount = 20,
            };
        }
        await cfg.Validate(cfg.ApplicationType);
        app.ApplicationConfiguration = cfg;
        if (!await app.CheckApplicationInstanceCertificate(server, 0))
            throw new InvalidOperationException("Không tạo được chứng chỉ ứng dụng OPC UA");
        return cfg;
    }
}
