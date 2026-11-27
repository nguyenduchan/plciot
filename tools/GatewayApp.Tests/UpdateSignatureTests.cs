using System.Security.Cryptography;
using GatewayApp;

public class UpdateSignatureTests
{
    static (string Pub, Func<string, string, int, string> Sign) NewKey()
    {
        var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var pub = B64u(ec.ExportSubjectPublicKeyInfo());
        return (pub, (sha, ver, lvl) => B64u(ec.SignData(UpdateSignature.Message(sha, ver, lvl), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)));
    }
    static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    const string Sha = "2b8aed79c47b207327b0eaea2ff348f59a549d22f68fa4482af04703ea9a70d0";

    [Fact]
    public void ChuKyDung_DuocChapNhan()
    {
        var (pub, sign) = NewKey();
        Assert.True(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, sign(Sha, "fef4d366a8e6", 1), new[] { pub }));
        Assert.True(UpdateSignature.Verify(Sha.ToUpperInvariant(), "fef4d366a8e6", 1, sign(Sha, "fef4d366a8e6", 1), new[] { pub }));
    }

    [Fact]
    public void TraoGoi_DoiVersion_DoiApiLevel_KhoaLa_DeuBiTuChoi()
    {
        var (pub, sign) = NewKey();
        var (other, _) = NewKey();
        var sig = sign(Sha, "fef4d366a8e6", 1);
        Assert.False(UpdateSignature.Verify(Sha.Replace('2', '3'), "fef4d366a8e6", 1, sig, new[] { pub }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e7", 1, sig, new[] { pub }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 2, sig, new[] { pub }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, sig, new[] { other }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, "", new[] { pub }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, null, new[] { pub }));
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, "!!khong-phai-base64", new[] { pub }));
        Assert.True(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, sig, new[] { other, pub }));   // nhiều khoá (đang đổi khoá)
    }

    [Fact]
    public void KhoaGanCung_HopLe_VaKhongNhanChuKyGia()
    {
        Assert.NotEmpty(UpdateSignature.TrustedKeys);
        var (_, sign) = NewKey();
        Assert.False(UpdateSignature.Verify(Sha, "fef4d366a8e6", 1, sign(Sha, "fef4d366a8e6", 1)));
        foreach (var k in UpdateSignature.TrustedKeys)
        {
            using var ec = ECDsa.Create();
            ec.ImportSubjectPublicKeyInfo(Convert.FromBase64String(k.Replace('-', '+').Replace('_', '/').PadRight(k.Length + (4 - k.Length % 4) % 4, '=')), out _);
            Assert.Equal(256, ec.KeySize);
        }
    }

    [Theory]
    [InlineData("https://plc.dieukhientudong.net", true)]
    [InlineData("https://plc.dieukhientudong.net/", true)]
    [InlineData("http://plc.dieukhientudong.net", false)]
    [InlineData("http://14.225.224.218:3080", false)]
    [InlineData("http://192.168.1.10:3080", true)]
    [InlineData("http://10.0.0.5", true)]
    [InlineData("http://172.20.1.1", true)]
    [InlineData("http://172.32.1.1", false)]
    [InlineData("http://localhost:3080", true)]
    [InlineData("http://127.0.0.1:3080", true)]
    [InlineData("http://scada-pc:3080", true)]
    [InlineData("http://server.local", true)]
    [InlineData("ftp://192.168.1.10", false)]
    [InlineData("", false)]
    [InlineData("plc.dieukhientudong.net", false)]
    public void ChiCapNhatQuaHttps_HoacHttpTrongLan(string server, bool ok) => Assert.Equal(ok, UpdateSignature.ServerAllowed(server, out _));
}
