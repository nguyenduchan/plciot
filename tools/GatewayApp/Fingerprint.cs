using System.Security.Cryptography;
using System.Text;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Vân tay ngắn của gateway (XXXX-XXXX) hiện trên màn hình gateway và trang admin để người duyệt đối chiếu đúng máy.</summary>
static class Fingerprint
{
    public static string Of(ScadaConfig cfg)
    {
        var raw = Encoding.UTF8.GetBytes($"{Environment.MachineName}|{Environment.UserName}|{cfg.Device}");
        var h = Convert.ToHexString(SHA256.HashData(raw));
        return $"{h[..4]}-{h[4..8]}";
    }
}
