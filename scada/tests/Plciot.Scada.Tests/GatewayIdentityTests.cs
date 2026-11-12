using System.Text.Json;
using Plciot.Scada.Services.Ui;
using Xunit;

namespace Plciot.Scada.Tests;

/// <summary>Danh tính khoá công khai của gateway: sinh/nạp khoá, ID máy ổn định, chuẩn hoá mã, và xuất fixture để server (Node) xác minh chéo.</summary>
public class GatewayIdentityTests
{
    [Fact]
    public void Khoa_sinh_mot_lan_va_nap_lai_cho_cung_ID_may()
    {
        var key = "";
        using var a = GatewayIdentity.LoadOrCreate(ref key, out var created);
        Assert.True(created); Assert.False(string.IsNullOrEmpty(key));
        var saved = key;
        using var b = GatewayIdentity.LoadOrCreate(ref key, out var created2);
        Assert.False(created2); Assert.Equal(saved, key);
        Assert.Equal(a.Hw, b.Hw); Assert.Equal(a.PublicKey, b.PublicKey);
        Assert.Equal(20, a.Hw.Length);
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{20}$", a.Hw);
    }

    [Fact]
    public void Khoa_hong_thi_sinh_khoa_moi()
    {
        var key = "khong-phai-khoa";
        using var a = GatewayIdentity.LoadOrCreate(ref key, out var created);
        Assert.True(created);
    }

    [Theory]
    [InlineData("k7qm-2xpd", "K7QM2XPD")]
    [InlineData(" o0il-abcd ", "0011ABCD")]
    public void Chuan_hoa_ma_giong_server(string raw, string want) => Assert.Equal(want, GatewayIdentity.NormalizeCode(raw));

    [Fact]
    public void Lay_site_device_tu_QR_va_link()
    {
        var payload = JsonSerializer.Serialize(new { v = 1, site = "tram_a", device = "gw01", claim = "x", sig = "y" });
        var qr = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal(("tram_a", "gw01"), GatewayIdentity.SiteDeviceOfQr(qr));
        Assert.Equal(("tram_a", "gw01"), GatewayIdentity.SiteDeviceOfQr($"https://plc.example/login.html?claim={Uri.EscapeDataString(qr)}"));
        Assert.Null(GatewayIdentity.SiteDeviceOfQr("khong-phai-qr"));
    }

    /// <summary>GW_FIXTURE_OUT=đường dẫn → ghi khoá công khai + chữ ký để cloud/app/scripts/verify-cs-proof.js kiểm tra bằng server thật.</summary>
    [Fact]
    public void Xuat_fixture_cho_server_xac_minh()
    {
        var path = Environment.GetEnvironmentVariable("GW_FIXTURE_OUT");
        if (string.IsNullOrEmpty(path)) return;
        var key = "";
        using var id = GatewayIdentity.LoadOrCreate(ref key, out _);
        var pair = id.PairProof("K7QM-2XPD");
        var enroll = id.RequestProof("enroll", "tram_a", "gw01");
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            pubkey = id.PublicKey, hw = id.Hw,
            pair = new { code = "K7QM-2XPD", ts = pair.Ts, sig = pair.Sig },
            enroll = new { site = "tram_a", device = "gw01", ts = enroll.Ts, sig = enroll.Sig },
        }));
    }
}
