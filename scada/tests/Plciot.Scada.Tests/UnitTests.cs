using System.Text;

namespace Plciot.Scada.Tests;

public class CommandPolicyTests
{
    static (PlcCommand? c, string? e, string? id) P(string json) => CommandPolicy.Parse(Encoding.UTF8.GetBytes(json));

    [Theory]
    [InlineData("{\"id\":\"x\",\"a\":3,\"v\":1}")]
    [InlineData("{\"id\":\"x\",\"a\":4,\"v\":255}")]
    [InlineData("{\"id\":\"x\",\"a\":6,\"v\":0}")]
    [InlineData("{\"id\":\"x\",\"a\":7,\"v\":65535}")]
    [InlineData("{\"id\":\"x\",\"a\":9,\"v\":1}")]
    public void Whitelisted_writes_are_accepted(string json)
    {
        var (c, e, _) = P(json);
        Assert.Null(e);
        Assert.False(c!.IsRead);
    }

    [Theory]
    [InlineData("{\"id\":\"x\",\"a\":0,\"v\":1}", "not_writable")]     // D0 = đầu vào X, chỉ đọc
    [InlineData("{\"id\":\"x\",\"a\":14,\"v\":0}", "not_writable")]    // số đếm do PLC giữ
    [InlineData("{\"id\":\"x\",\"a\":6,\"v\":65536}", "bad_value")]
    [InlineData("{\"id\":\"x\",\"a\":6,\"v\":-1}", "bad_value")]
    [InlineData("{\"id\":\"x\",\"a\":300,\"v\":1}", "bad_address")]
    [InlineData("{\"id\":\"x\",\"a\":-1,\"v\":1}", "bad_address")]
    [InlineData("{\"id\":\"x\",\"v\":1}", "bad_address")]
    [InlineData("{\"id\":\"x\",\"a\":6}", "bad_value")]
    [InlineData("[1,2,3]", "bad_cmd")]
    [InlineData("not json", "bad_json")]
    public void Dangerous_or_malformed_commands_are_rejected(string json, string error)
    {
        var (c, e, _) = P(json);
        Assert.Null(c);
        Assert.Equal(error, e);
    }

    [Fact]
    public void Read_ranges_are_bounded()
    {
        Assert.NotNull(P("{\"id\":\"r\",\"op\":\"read\",\"a\":100,\"n\":4}").c);
        Assert.Equal("bad_range", P("{\"id\":\"r\",\"op\":\"read\",\"a\":100,\"n\":61}").e);
        Assert.Equal("bad_range", P("{\"id\":\"r\",\"op\":\"read\",\"a\":290,\"n\":20}").e);
        Assert.Equal("bad_range", P("{\"id\":\"r\",\"op\":\"read\",\"a\":0,\"n\":0}").e);
    }

    [Fact]
    public void Oversized_payload_is_rejected()
    {
        var big = "{\"id\":\"" + new string('a', 600) + "\",\"a\":6,\"v\":1}";
        Assert.Equal("bad_size", P(big).e);
        Assert.Equal("bad_size", CommandPolicy.Parse(ReadOnlySpan<byte>.Empty).Error);
    }

    [Fact]
    public void Ack_json_has_contract_shape()
    {
        Assert.Equal("{\"id\":\"x\",\"ok\":true}", CommandPolicy.AckJson("x", true));
        Assert.Contains("\"err\":\"remote_disabled\"", CommandPolicy.AckJson("x", false, "remote_disabled"));
        Assert.Contains("\"v\":[1,2]", CommandPolicy.AckJson("x", true, null, 5, new ushort[] { 1, 2 }));
    }
}

public class ModbusClientTests
{
    [Fact]
    public async Task Reads_and_writes_registers()
    {
        using var plc = new FakeModbusPlc();
        using var c = new ModbusTcpClient("127.0.0.1", plc.Port, 1);
        var r = await c.ReadHoldingAsync(0, 40);
        Assert.Equal(40, r.Length);
        Assert.Equal(5, r[0]);
        Assert.Equal(7, r[14]);
        await c.WriteSingleAsync(6, 1);
        Assert.Equal(1, plc.Get(6));
        Assert.Equal(1, (await c.ReadHoldingAsync(6, 1))[0]);
    }

    [Fact]
    public async Task Exception_response_is_reported_and_connection_recovers()
    {
        using var plc = new FakeModbusPlc();
        using var c = new ModbusTcpClient("127.0.0.1", plc.Port, 1);
        await Assert.ThrowsAsync<ModbusException>(() => c.ReadHoldingAsync(290, 20));   // quá 300 → exception 2
        Assert.Equal(5, (await c.ReadHoldingAsync(0, 1))[0]);                            // nối lại tự động
    }

    [Fact]
    public async Task Unreachable_plc_times_out_or_refuses()
    {
        using var c = new ModbusTcpClient("127.0.0.1", Net.FreePort(), 1, 500);
        await Assert.ThrowsAnyAsync<Exception>(() => c.ReadHoldingAsync(0, 1));
    }
}

public class ConfigTests
{
    [Fact]
    public void Passwords_are_not_stored_in_clear_on_windows_and_roundtrip()
    {
        var path = Path.Combine(Path.GetTempPath(), $"scada-{Guid.NewGuid():N}.json");
        try
        {
            var cfg = new ScadaConfig { CloudPassword = "cloud-secret-123" };
            cfg.LocalUsers.Add(new LocalUser { User = "op", Password = "local-secret-456", Role = LocalRole.Operator });
            ConfigStore.Save(path, cfg);
            var raw = File.ReadAllText(path);
            if (OperatingSystem.IsWindows())
            {
                Assert.DoesNotContain("cloud-secret-123", raw);
                Assert.DoesNotContain("local-secret-456", raw);
            }
            var back = ConfigStore.Load(path);
            Assert.Equal("cloud-secret-123", back.CloudPassword);
            Assert.Equal("local-secret-456", back.LocalUsers.Single(u => u.User == "op").Password);
            Assert.Equal(LocalRole.Operator, back.LocalUsers.Single(u => u.User == "op").Role);
        }
        finally { File.Delete(path); }
    }

    [Theory]
    [InlineData("a/b", "plc01")]
    [InlineData("site", "../x")]
    [InlineData("", "plc01")]
    public void Unsafe_topic_parts_are_invalid(string site, string dev)
    {
        Assert.NotNull(new ScadaConfig { Site = site, Device = dev }.Validate());
    }
}
