using System.Text;

namespace Plciot.Scada.Tests;

/// <summary>Lệnh cloud có chữ ký (thay OTP cho điều khiển từ xa) + mật khẩu cục bộ (thay OTP cho sửa cấu hình tại máy).</summary>
public class CloudCmdSecurityTests
{
    // Vector sinh bằng cloud/app/src/cmdSign.js (Node) → kiểm tính tương thích chéo Node ↔ .NET
    const string ServerKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXBOkpWq9UG4R7aHXzfga00Yn9C-TVA8du0gkB86keO4IMOF3GcdsERRaxlSpIgoi7xD7hdLx1CfSp26W9GnygA";
    const string MqttId = "0123456789abcdef";
    const string Signed = "{\"schema\":1,\"id\":\"t1\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1,\"ts\":1700000000000,\"sig\":\"XG5BkF5SVpZ6RgCa4xO_faro95L4g-CFqxV6bybMPoG_WDM12ulTUXkDrTJ4A_DGXDccE__24QmjC70gUhIhpQ\"}";

    [Fact]
    public void Signature_from_node_verifies_and_returns_plain_json_without_sig()
    {
        Assert.True(CmdSignature.TryVerify(Encoding.UTF8.GetBytes(Signed), MqttId, ServerKey, out var plain));
        var s = Encoding.UTF8.GetString(plain);
        Assert.DoesNotContain("sig", s);
        Assert.EndsWith("\"ts\":1700000000000}", s);
    }

    [Fact]
    public void Wrong_gateway_tampered_or_unsigned_command_is_rejected()
    {
        Assert.False(CmdSignature.TryVerify(Encoding.UTF8.GetBytes(Signed), "ffffffffffffffff", ServerKey, out _));              // lệnh của gateway khác
        Assert.False(CmdSignature.TryVerify(Encoding.UTF8.GetBytes(Signed.Replace("\"v\":1", "\"v\":9")), MqttId, ServerKey, out _)); // sửa giá trị
        Assert.False(CmdSignature.TryVerify(Encoding.UTF8.GetBytes("{\"id\":\"t1\",\"a\":6,\"v\":1}"), MqttId, ServerKey, out _));    // không ký
        Assert.False(CmdSignature.TryVerify(Encoding.UTF8.GetBytes(Signed), MqttId, "bad-key", out _));
    }

    [Fact]
    public void Local_password_hash_verifies_only_the_right_password()
    {
        var h = LocalPassword.Create("mat-khau-manh-1");
        Assert.StartsWith("pbkdf2$", h);
        Assert.True(LocalPassword.Verify("mat-khau-manh-1", h));
        Assert.False(LocalPassword.Verify("mat-khau-manh-2", h));
        Assert.False(LocalPassword.Verify("x", "rac"));
        Assert.NotEqual(h, LocalPassword.Create("mat-khau-manh-1"));   // muối ngẫu nhiên
    }

    [Fact]
    public async Task Control_gate_blocks_unsigned_but_trusted_signed_command_passes()
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150,
            WebEnabled = false, LocalPort = Net.FreePort(), LocalBind = "127.0.0.1",
        };
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        host.Core.ControlGate = () => false;   // chưa mở khoá tại máy
        var cmd = Encoding.UTF8.GetBytes("{\"id\":\"c1\",\"a\":6,\"v\":1}");
        var denied = await host.Core.ExecuteAsync(cmd, ControlSource.LocalScreen, "ui");
        Assert.Contains("otp_required", denied);
        Assert.NotEqual(1, plc.Get(6));
        var ok = await host.Core.ExecuteAsync(cmd, ControlSource.LocalScreen, "cloud", default, trusted: true);
        Assert.DoesNotContain("otp_required", ok ?? "");
        Assert.Equal(1, plc.Get(6));
    }
}
