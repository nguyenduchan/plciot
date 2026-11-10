using System.Text.Json;

namespace Plciot.Scada.Tests;

/// <summary>Bản tin &lt;base&gt;/config sinh từ Pack + hiển thị do giao diện đặt: một thiết bị nhiều field đọc/ghi.</summary>
public class ConfigBuilderTests
{
    sealed class Desc : IConfigDescriber
    {
        public string? DeviceTitle(string child) => child == "pump1" ? "Bơm nước" : null;
        public FieldView? Field(string child, string field) => (child, field) switch
        {
            ("pump1", "run") => new FieldView("Chạy bơm", "", "switch"),
            ("pump1", "flow") => new FieldView("Lưu lượng", "L/phút", "gauge", 0, 80),
            _ => null,
        };
    }

    static ScadaConfig Cfg() => new()
    {
        Site = "s", Device = "GW01",
        Pack =
        {
            new() { Child = "pump1", Field = "run", Address = 51, Access = PackAccess.ReadWrite, Min = 0, Max = 1 },
            new() { Child = "pump1", Field = "speed", Address = 52, Access = PackAccess.Write, Min = 0, Max = 100 },
            new() { Child = "pump1", Field = "flow", Address = 54, Access = PackAccess.Read },
            new() { Child = "env1", Field = "t", Address = 55, Access = PackAccess.Read },
        },
    };

    [Fact]
    public void Config_groups_fields_per_device_with_access_and_labels()
    {
        using var doc = JsonDocument.Parse(ConfigBuilder.Build(Cfg(), new Desc()));
        var r = doc.RootElement;
        Assert.Equal("GW01", r.GetProperty("gw").GetString());
        var devs = r.GetProperty("devices").EnumerateArray().ToList();
        Assert.Equal(new[] { "pump1", "env1" }, devs.Select(d => d.GetProperty("id").GetString()));
        var pump = devs[0];
        Assert.Equal("Bơm nước", pump.GetProperty("name").GetString());
        var f = pump.GetProperty("fields").EnumerateArray().ToDictionary(x => x.GetProperty("key").GetString()!);
        Assert.Equal(3, f.Count);
        Assert.Equal("switch", f["run"].GetProperty("widget").GetString());
        Assert.True(f["run"].GetProperty("writable").GetBoolean());
        Assert.Equal("slider", f["speed"].GetProperty("widget").GetString());        // suy: ghi được, khoảng 0–100
        Assert.True(f["speed"].GetProperty("writable").GetBoolean());
        Assert.False(f["flow"].TryGetProperty("writable", out _));                    // chỉ đọc → không có writable
        Assert.Equal("L/phút", f["flow"].GetProperty("unit").GetString());
        Assert.Equal(80, f["flow"].GetProperty("max").GetDouble());                   // khoảng người dùng đặt thắng Pack
        Assert.Equal("env1", devs[1].GetProperty("name").GetString());                // không có tên → dùng mã
        Assert.Equal("kpi", devs[1].GetProperty("fields")[0].GetProperty("widget").GetString());
    }

    [Fact]
    public void Config_is_empty_device_list_when_no_pack()
    {
        using var doc = JsonDocument.Parse(ConfigBuilder.Build(new ScadaConfig { Device = "GW01" }));
        Assert.Empty(doc.RootElement.GetProperty("devices").EnumerateArray());
    }

    [Fact]
    public void Config_kind_is_upstream_retained_contract()
    {
        Assert.Contains("config", Contract.Kinds);
        Assert.True(Contract.IsUpstream("config"));
        Assert.Equal("config", Contract.KindOf("plc/s/GW01/config", "plc/s/GW01"));
    }

    [Fact]
    public void Mqtt_key_alias_is_used_in_config_and_must_be_unique()
    {
        var cfg = Cfg();
        cfg.Pack.First(p => p.Field == "flow").MqttKey = "q_flow";
        using var doc = JsonDocument.Parse(ConfigBuilder.Build(cfg, new Desc()));
        var keys = doc.RootElement.GetProperty("devices")[0].GetProperty("fields").EnumerateArray().Select(f => f.GetProperty("key").GetString()).ToList();
        Assert.Contains("q_flow", keys);
        Assert.DoesNotContain("flow", keys);
        Assert.Equal("q_flow", cfg.Pack.First(p => p.Field == "flow").WireKey);
        Assert.Equal("run", cfg.Pack.First(p => p.Field == "run").WireKey);
    }

    sealed class StyledDesc : IConfigDescriber
    {
        public string? DeviceTitle(string child) => "Bơm nước";
        public FieldView? Field(string child, string field) =>
            field == "run" ? new FieldView("Bơm", "", "switch", On: "Đang chạy", Off: "Dừng")
            : field == "flow" ? new FieldView("Lưu lượng", "L/phút", "tank", 0, 100, Low: 15, High: 90) : null;
        public DeviceView? Style(string child) => new DeviceView("pump", "blue");
    }

    [Fact]
    public void Config_carries_ui_style_icon_color_texts_and_thresholds()
    {
        using var doc = JsonDocument.Parse(ConfigBuilder.Build(Cfg(), new StyledDesc()));
        var pump = doc.RootElement.GetProperty("devices")[0];
        Assert.Equal("pump", pump.GetProperty("icon").GetString());
        Assert.Equal("blue", pump.GetProperty("color").GetString());
        var fields = pump.GetProperty("fields").EnumerateArray().ToList();
        var run = fields.First(f => f.GetProperty("key").GetString() == "run");
        Assert.Equal("Đang chạy", run.GetProperty("on").GetString());
        var flow = fields.First(f => f.GetProperty("key").GetString() == "flow");
        Assert.Equal("tank", flow.GetProperty("widget").GetString());
        Assert.Equal(15, flow.GetProperty("low").GetDouble());
        Assert.Equal(90, flow.GetProperty("high").GetDouble());
    }
}
