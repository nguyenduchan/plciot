using GatewayLicense;
using Xunit;

namespace GatewayLicense.Tests;

/// <summary>Vector lấy từ server thật (VPS) ngày 2026-11-07: mã do Node ký, thư viện C# phải kiểm đúng.</summary>
public class ActivationCodeTests
{
    const string Hw = "GW7K2M9X";
    const string Key = "9f1ecd5318bff8bdbfc35c9121d09e573211fc6600c49c7409bfadcead92a456";
    static readonly DateTime Now = new(2026, 11, 7, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Server_code_without_expiry_is_accepted()
    {
        Assert.Equal(VerifyError.None, ActivationCode.Verify("000ZK-MVDZD-JQ2N6-PHH5Q", Hw, "A4QP8RTC", Key, Now, out var exp));
        Assert.Equal(0, exp);
    }

    [Fact]
    public void Server_code_with_expiry_is_accepted_then_expires()
    {
        Assert.Equal(VerifyError.None, ActivationCode.Verify("60806-AABGA-W7BFB-7H33R", Hw, "B5RQ9SVD", Key, Now, out var exp));
        Assert.True(exp > 0);
        Assert.Equal(VerifyError.Expired, ActivationCode.Verify("60806-AABGA-W7BFB-7H33R", Hw, "B5RQ9SVD", Key, new DateTime(2040, 1, 1, 0, 0, 0, DateTimeKind.Utc), out _));
    }

    [Fact]
    public void Typing_variants_are_accepted()
    {
        Assert.Equal(VerifyError.None, ActivationCode.Verify("000zk mvdzd jq2n6 phh5q", "gw7k-2m9x", "a4qp-8rtc", Key, Now, out _));
        // O đọc là 0, I/L đọc là 1
        Assert.Equal(VerifyError.None, ActivationCode.Verify("OOOZK-MVDZD-JQ2N6-PHH5Q", Hw, "A4QP8RTC", Key, Now, out _));
    }

    [Fact]
    public void Wrong_challenge_or_key_is_rejected()
    {
        Assert.Equal(VerifyError.WrongDevice, ActivationCode.Verify("000ZK-MVDZD-JQ2N6-PHH5Q", Hw, "B5RQ9SVD", Key, Now, out _));
        Assert.Equal(VerifyError.WrongDevice, ActivationCode.Verify("000ZK-MVDZD-JQ2N6-PHH5Q", Hw, "A4QP8RTC", new string('a', 64), Now, out _));
        Assert.Equal(VerifyError.WrongDevice, ActivationCode.Verify("000ZK-MVDZD-JQ2N6-PHH5Q", "GWZZ1111", "A4QP8RTC", Key, Now, out _));
    }

    [Fact]
    public void Typo_is_reported_as_typo_not_wrong_device()
    {
        Assert.Equal(VerifyError.Typo, ActivationCode.Verify("000ZK-MVDZD-JQ2N6-PHH5R", Hw, "A4QP8RTC", Key, Now, out _));
        Assert.Equal(VerifyError.Typo, ActivationCode.Verify("000ZK-MVDZD", Hw, "A4QP8RTC", Key, Now, out _));
        Assert.Equal(VerifyError.Typo, ActivationCode.Verify("", Hw, "A4QP8RTC", Key, Now, out _));
    }

    [Fact]
    public void NewRequest_ends_with_its_nonce_and_is_random()
    {
        var (req, nonce) = ActivationCode.NewRequest(Hw);
        Assert.Equal(8, nonce.Length);
        Assert.EndsWith(nonce, ActivationCode.Normalize(req));
        Assert.StartsWith(Hw, ActivationCode.Normalize(req));
        Assert.NotEqual(nonce, ActivationCode.NewRequest(Hw).Nonce);
    }

    [Fact]
    public void KeyFile_parses_and_validates()
    {
        var k = KeyFile.Parse($"{{\"v\":1,\"hw\":\"gw7k-2m9x\",\"key\":\"{Key.ToUpperInvariant()}\"}}");
        Assert.Equal(Hw, k.Hw);
        Assert.Equal(Key, k.Key);
        Assert.Throws<FormatException>(() => KeyFile.Parse("{\"hw\":\"GW7K2M9X\",\"key\":\"abc\"}"));
    }

    // Khoá bản quyền (gateway không internet): chỉ cần ID máy, vector do server thật sinh ngày 2026-11-08.
    [Fact]
    public void License_key_from_server_is_accepted_without_nonce()
    {
        Assert.Equal(VerifyError.None, ActivationCode.VerifyLicense("000E6-8S5VT-CWT82-MY8RY", Hw, Key, Now, out var exp));
        Assert.Equal(0, exp);
        Assert.Equal(VerifyError.None, ActivationCode.VerifyLicense("000e68s5vtcwt82my8ry", "gw7k-2m9x", Key, Now, out _));
    }

    [Fact]
    public void License_key_with_expiry_expires()
    {
        Assert.Equal(VerifyError.None, ActivationCode.VerifyLicense("2SMN7-062QK-911YR-R1Z7T", Hw, Key, Now, out var exp));
        Assert.True(exp > 0);
        Assert.Equal(VerifyError.Expired, ActivationCode.VerifyLicense("2SMN7-062QK-911YR-R1Z7T", Hw, Key, new DateTime(2029, 1, 1, 0, 0, 0, DateTimeKind.Utc), out _));
    }

    [Fact]
    public void License_key_is_bound_to_the_machine_id_and_not_interchangeable_with_challenge_codes()
    {
        Assert.Equal(VerifyError.WrongDevice, ActivationCode.VerifyLicense("000E6-8S5VT-CWT82-MY8RY", "OTHER999", Key, Now, out _));
        Assert.Equal(VerifyError.Typo, ActivationCode.VerifyLicense("000E6-8S5VT-CWT82-MY8RZ", Hw, Key, Now, out _));
        // mã thử thách không được chấp nhận như khoá bản quyền, và ngược lại
        Assert.Equal(VerifyError.WrongDevice, ActivationCode.VerifyLicense("000ZK-MVDZD-JQ2N6-PHH5Q", Hw, Key, Now, out _));
        Assert.NotEqual(VerifyError.None, ActivationCode.Verify("000E6-8S5VT-CWT82-MY8RY", Hw, "A4QP8RTC", Key, Now, out _));
    }
}
