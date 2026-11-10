using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Plciot.Scada;

/// <summary>Cách một field được hiển thị trên webapp (do người dùng đặt khi thêm thiết bị trong giao diện gateway).</summary>
public sealed record FieldView(string Label, string Unit, string Widget, double? Min = null, double? Max = null,
    string? On = null, string? Off = null, double? Low = null, double? High = null);

/// <summary>Kiểu thẻ thiết bị trên webapp: icon = mã biểu tượng (tank, pump, env, valve, motor, energy, pressure, conveyor, di, do, custom), color = blue|green|yellow|red|purple|orange.</summary>
public sealed record DeviceView(string? Icon = null, string? Color = null);

/// <summary>Nguồn tên/nhãn hiển thị cho bản tin config. Giao diện gateway cài đặt; lõi không biết gì về giao diện.</summary>
public interface IConfigDescriber
{
    string? DeviceTitle(string child);
    FieldView? Field(string child, string field);
    /// <summary>Biểu tượng + màu nhấn của thẻ thiết bị; null = để webapp dùng mặc định.</summary>
    DeviceView? Style(string child) => null;
}

/// <summary>
/// Dựng bản tin &lt;base&gt;/config từ Pack: mỗi thiết bị (child) có nhiều field, mỗi field là một điểm đọc / ghi
/// (Access: Read | Write | ReadWrite). Mọi trường trong bản tin lấy từ khai báo của người dùng, không có giá trị ngầm định ở lõi
/// ngoài việc suy widget khi giao diện không đặt:
///   {"gw":"GW01","devices":[{"id":"pump1","name":"Bơm","fields":[
///       {"key":"run","lbl":"Bơm","widget":"switch","writable":true},
///       {"key":"flow","lbl":"Lưu lượng","unit":"L/phút","widget":"gauge","min":0,"max":100}]}]}
/// Telemetry (&lt;base&gt;/telemetry) và lệnh (&lt;base&gt;/cmd {child,key,v}) dùng cùng child/field này nên luôn khớp.
/// </summary>
public static class ConfigBuilder
{
    sealed class FieldDto
    {
        [JsonPropertyName("key")] public string Key { get; set; } = "";
        [JsonPropertyName("lbl")] public string Lbl { get; set; } = "";
        [JsonPropertyName("unit"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Unit { get; set; }
        [JsonPropertyName("widget")] public string Widget { get; set; } = "kpi";
        [JsonPropertyName("writable"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Writable { get; set; }
        [JsonPropertyName("min"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Min { get; set; }
        [JsonPropertyName("max"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Max { get; set; }
        [JsonPropertyName("on"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? On { get; set; }
        [JsonPropertyName("off"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Off { get; set; }
        [JsonPropertyName("low"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Low { get; set; }
        [JsonPropertyName("high"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? High { get; set; }
    }

    sealed class DeviceDto
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("icon"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Icon { get; set; }
        [JsonPropertyName("color"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Color { get; set; }
        [JsonPropertyName("fields")] public List<FieldDto> Fields { get; set; } = new();
    }

    public static byte[] Build(ScadaConfig cfg, IConfigDescriber? describer = null) =>
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { gw = cfg.Device, devices = Devices(cfg, describer) }));

    static List<DeviceDto> Devices(ScadaConfig cfg, IConfigDescriber? d)
    {
        var list = new List<DeviceDto>();
        foreach (var g in cfg.Pack.GroupBy(p => p.Child))
        {
            var title = d?.DeviceTitle(g.Key);
            var dev = new DeviceDto { Id = g.Key, Name = string.IsNullOrWhiteSpace(title) ? g.Key : title! };
            var st = d?.Style(g.Key);
            dev.Icon = string.IsNullOrWhiteSpace(st?.Icon) ? null : st!.Icon;
            dev.Color = string.IsNullOrWhiteSpace(st?.Color) ? null : st!.Color;
            foreach (var p in g)
            {
                var v = d?.Field(p.Child, p.Field);
                var writable = p.Access != PackAccess.Read;
                var min = v?.Min ?? p.Min; var max = v?.Max ?? p.Max;
                dev.Fields.Add(new FieldDto
                {
                    Key = p.WireKey,
                    Lbl = string.IsNullOrWhiteSpace(v?.Label) ? p.Field : v!.Label,
                    Unit = string.IsNullOrEmpty(v?.Unit) ? null : v!.Unit,
                    Widget = string.IsNullOrEmpty(v?.Widget) ? Infer(writable, min, max) : v!.Widget,
                    Writable = writable ? true : null,
                    Min = min, Max = max,
                    On = string.IsNullOrEmpty(v?.On) ? null : v!.On, Off = string.IsNullOrEmpty(v?.Off) ? null : v!.Off,
                    Low = v?.Low, High = v?.High,
                });
            }
            list.Add(dev);
        }
        return list;
    }

    /// <summary>Giao diện không đặt kiểu hiển thị: ghi được và khoảng 0–1 → công tắc; ghi được → thanh trượt; còn lại → số.</summary>
    static string Infer(bool writable, double? min, double? max) =>
        !writable ? "kpi" : (max is <= 1 && min is >= 0 ? "switch" : "slider");
}
