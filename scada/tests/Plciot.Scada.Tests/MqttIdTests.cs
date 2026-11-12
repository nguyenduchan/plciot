using System.Text.Json;
using Plciot.Scada;

namespace Plciot.Scada.Tests;

/// <summary>Id MQTT ngẫu nhiên do server cấp: gateway ghép vào topic gw/&lt;id&gt;/&lt;kind&gt;, không lộ site/device.</summary>
public class MqttIdTests
{
    const string Id = "0123456789abcdef";

    [Fact]
    public void Registered_gateway_uses_gw_topic_with_server_issued_id_and_hides_site_device()
    {
        var c = new ScadaConfig { Site = "nhamay_a", Device = "gw01", MqttId = Id };
        Assert.Equal($"gw/{Id}", c.BaseTopic);
        Assert.DoesNotContain("nhamay_a", c.BaseTopic);
        Assert.DoesNotContain("gw01", c.BaseTopic);
        Assert.Equal("telemetry", Contract.KindOf($"gw/{Id}/telemetry", c.BaseTopic));
        Assert.Equal("cmd", Contract.KindOf($"gw/{Id}/cmd", c.BaseTopic));
        Assert.Null(Contract.KindOf("gw/ffffffffffffffff/telemetry", c.BaseTopic));      // id của gateway khác
        Assert.Null(Contract.KindOf("plc/nhamay_a/gw01/telemetry", c.BaseTopic));        // topic cũ theo tên
    }

    [Fact]
    public void Unregistered_gateway_keeps_local_only_topic()
    {
        var c = new ScadaConfig { Site = "s1", Device = "d1" };
        Assert.Equal("plc/s1/d1", c.BaseTopic);        // broker LAN; cloud không nhận dạng topic này
    }

    [Theory]
    [InlineData("0123456789abcdef", true)]
    [InlineData("0123456789ABCDEF", false)]   // chỉ hex thường như server cấp
    [InlineData("0123456789abcde", false)]
    [InlineData("0123456789abcdef0", false)]
    [InlineData("plant1/gw01", false)]
    [InlineData("", false)]
    public void Mqtt_id_format(string id, bool valid) => Assert.Equal(valid, Contract.IsMqttId(id));

    [Fact]
    public void Config_rejects_malformed_id_and_round_trips_valid_one()
    {
        var bad = new ScadaConfig { MqttId = "site/device" };
        Assert.Contains("MqttId", bad.Validate());
        var c = new ScadaConfig { MqttId = Id };
        Assert.Null(c.Validate());
        var back = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(c))!;
        Assert.Equal(Id, back.MqttId);
        Assert.Equal($"gw/{Id}", back.BaseTopic);
        Assert.Equal("", JsonSerializer.Deserialize<ScadaConfig>("{}")!.MqttId);         // cấu hình cũ chưa có id
    }
}
