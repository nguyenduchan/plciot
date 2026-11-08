using System.Net;
using System.Text.Json;

namespace Plciot.Scada.Tests;

/// <summary>Kích hoạt gateway PC (online gắn máy / offline giấy phép). Vector khoá lấy từ server thật ngày 2026-11-08.</summary>
public class ActivationTests : IDisposable
{
    const string Hw = "GW7K2M9X";
    const string Key = "9f1ecd5318bff8bdbfc35c9121d09e573211fc6600c49c7409bfadcead92a456";
    const string Key2 = "67fc838f452ab58b9174575dabb763cfbbd895369d9188a70571e870c60a72a1";   // khoá riêng của máy PC0FF0001ZZ
    const string CodeNoExpiry = "000E6-8S5VT-CWT82-MY8RY";
    const string CodeExpiring = "2SMN7-062QK-911YR-R1Z7T";   // hết hạn khoảng 2027-11
    static readonly DateTime Now = new(2026, 11, 8, 0, 0, 0, DateTimeKind.Utc);

    readonly string _dir = Directory.CreateTempSubdirectory("plciot-act").FullName;
    public void Dispose() { try { Directory.Delete(_dir, true); } catch (IOException) { } }

    static string Lic(string code, string hw = Hw) => JsonSerializer.Serialize(new { v = 1, type = "plciot-license", hw, key = Key, code });

    // File giấy phép THẬT do GatewayProvisioner tạo từ server (kind=pc, offline) ngày 2026-11-08 — kiểm chéo đầu-cuối.
    [Fact]
    public void License_file_produced_by_the_provisioning_tool_is_accepted_only_on_its_machine()
    {
        var json = JsonSerializer.Serialize(new { v = 1, type = "plciot-license", hw = "PC0FF0001ZZ", key = Key2, code = "000ZQ-7WAP0-TQWNY-59TFK", mode = "license", exp = 0 });
        Assert.Equal(ActivationState.Active, GatewayActivation.CheckLicenseText(json, "PC0FF0001ZZ", Now).State);
        Assert.Equal(ActivationState.WrongMachine, GatewayActivation.CheckLicenseText(json, "PC0FF0002ZZ", Now).State);
    }

    [Fact]
    public void MachineId_is_stable_12_crockford_chars()
    {
        var a = GatewayActivation.MachineId();
        Assert.Equal(a, GatewayActivation.MachineId());
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{12}$", a);
    }

    [Fact]
    public void Valid_license_for_this_machine_is_active()
    {
        var st = GatewayActivation.CheckLicenseText(Lic(CodeNoExpiry), Hw, Now);
        Assert.Equal(ActivationState.Active, st.State);
        Assert.True(st.Allowed);
    }

    [Fact]
    public void License_copied_to_another_machine_is_rejected()
    {
        var st = GatewayActivation.CheckLicenseText(Lic(CodeNoExpiry), "XYZ7PC123456", Now);
        Assert.Equal(ActivationState.WrongMachine, st.State);
        Assert.Contains("XYZ7PC123456", st.Message);
        Assert.False(st.Allowed);
    }

    [Fact]
    public void Edited_hw_or_tampered_code_is_invalid()
    {
        // sửa hw trong file cho khớp máy mình → khoá riêng không còn khớp
        Assert.Equal(ActivationState.Invalid, GatewayActivation.CheckLicenseText(Lic(CodeNoExpiry, "XYZ7PC123456"), "XYZ7PC123456", Now).State);
        Assert.Equal(ActivationState.Invalid, GatewayActivation.CheckLicenseText(Lic("000E6-8S5VT-CWT82-MY8RZ"), Hw, Now).State);
        Assert.Equal(ActivationState.Invalid, GatewayActivation.CheckLicenseText("khong phai json", Hw, Now).State);
    }

    [Fact]
    public void Expiring_license_expires()
    {
        Assert.Equal(ActivationState.Active, GatewayActivation.CheckLicenseText(Lic(CodeExpiring), Hw, Now).State);
        Assert.Equal(ActivationState.Expired, GatewayActivation.CheckLicenseText(Lic(CodeExpiring), Hw, new DateTime(2029, 1, 1, 0, 0, 0, DateTimeKind.Utc)).State);
    }

    [Fact]
    public void Rolling_the_clock_back_is_detected_for_expiring_licenses()
    {
        var seen = Path.Combine(_dir, "lic.seen");
        var later = new DateTime(2027, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(ActivationState.Active, GatewayActivation.CheckLicenseText(Lic(CodeExpiring), Hw, later, seen).State);
        Assert.Equal(ActivationState.ClockTampered, GatewayActivation.CheckLicenseText(Lic(CodeExpiring), Hw, Now, seen).State);
        // giấy phép không hết hạn thì không cần mốc đồng hồ
        Assert.Equal(ActivationState.Active, GatewayActivation.CheckLicenseText(Lic(CodeNoExpiry), Hw, Now, seen).State);
    }

    [Fact]
    public void Missing_file_tells_the_customer_the_machine_id()
    {
        var st = GatewayActivation.CheckLicenseFile(Path.Combine(_dir, "none.json"), "ABC123DEF456", Now);
        Assert.Equal(ActivationState.NotActivated, st.State);
        Assert.Contains("ABC123DEF456", st.Message);
    }

    [Fact]
    public void Install_refuses_a_license_for_another_machine_and_saves_nothing()
    {
        var path = Path.Combine(_dir, "license.json");
        var st = GatewayActivation.InstallLicense(path, Lic(CodeNoExpiry), Now);   // MachineId() thật ≠ GW7K2M9X
        Assert.Equal(ActivationState.WrongMachine, st.State);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task Ensure_does_nothing_when_mode_is_none_and_blocks_offline_without_license()
    {
        await GatewayActivation.EnsureAsync(new ScadaConfig(), _ => { });
        var cfg = new ScadaConfig { LicenseMode = "offline", LicenseFile = Path.Combine(_dir, "x.json") };
        var ex = await Assert.ThrowsAsync<LicenseRequiredException>(() => GatewayActivation.EnsureAsync(cfg, _ => { }));
        Assert.Equal(GatewayActivation.MachineId(), ex.Status.MachineId);
        await Assert.ThrowsAsync<LicenseRequiredException>(() => GatewayActivation.EnsureAsync(new ScadaConfig { LicenseMode = "xyz" }, _ => { }));
    }

    sealed class Fake(Func<HttpRequestMessage, HttpResponseMessage> f) : HttpMessageHandler
    {
        public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            Body = r.Content == null ? null : await r.Content.ReadAsStringAsync(ct);
            return f(r);
        }
    }

    static HttpResponseMessage Json(HttpStatusCode c, string json) => new(c) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };

    [Fact]
    public async Task Online_enroll_sends_machine_id_and_stores_the_bound_marker()
    {
        var h = new Fake(_ => Json(HttpStatusCode.OK, "{\"ok\":true,\"site\":\"s1\",\"device\":\"d1\",\"schema\":2}"));
        var path = Path.Combine(_dir, "bound.json");
        var (st, kit) = await GatewayActivation.BindOnlineAsync(new HttpClient(h) { BaseAddress = new Uri("http://x/") }, "QR", path);
        Assert.Equal(ActivationState.Active, st.State);
        Assert.Equal("d1", kit?.Device);
        Assert.Contains($"\"hw\":\"{GatewayActivation.MachineId()}\"", h.Body);
        Assert.True(File.Exists(path));
    }

    [Fact]
    public async Task Online_enroll_rejected_when_another_machine_is_bound()
    {
        var h = new Fake(_ => Json(HttpStatusCode.Conflict, "{\"error\":\"device_already_activated\"}"));
        var (st, _) = await GatewayActivation.BindOnlineAsync(new HttpClient(h) { BaseAddress = new Uri("http://x/") }, "QR", Path.Combine(_dir, "b.json"));
        Assert.Equal(ActivationState.Rejected, st.State);
        Assert.Contains(GatewayActivation.MachineId(), st.Message);
    }

    [Fact]
    public async Task Online_without_network_runs_only_if_this_machine_was_bound_before()
    {
        var path = Path.Combine(_dir, "b.json");
        var down = new Fake(_ => throw new HttpRequestException("offline"));
        var (first, _) = await GatewayActivation.BindOnlineAsync(new HttpClient(down) { BaseAddress = new Uri("http://x/") }, "QR", path);
        Assert.Equal(ActivationState.NotActivated, first.State);

        File.WriteAllText(path, JsonSerializer.Serialize(new { v = 1, type = "bound", hw = GatewayActivation.MachineId() }));
        var (again, _) = await GatewayActivation.BindOnlineAsync(new HttpClient(down) { BaseAddress = new Uri("http://x/") }, "QR", path);
        Assert.Equal(ActivationState.Active, again.State);

        File.WriteAllText(path, JsonSerializer.Serialize(new { v = 1, type = "bound", hw = "SOMEONEELSE1" }));
        var (other, _) = await GatewayActivation.BindOnlineAsync(new HttpClient(down) { BaseAddress = new Uri("http://x/") }, "QR", path);
        Assert.Equal(ActivationState.NotActivated, other.State);
    }
}
