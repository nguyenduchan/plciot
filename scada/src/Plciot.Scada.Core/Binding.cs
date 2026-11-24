using System.Text.Json.Serialization;

namespace Plciot.Scada;

/// <summary>Quyền của gateway đối với một field: chỉ đọc (PLC → gateway), chỉ ghi (gateway → PLC), hoặc cả hai.</summary>
public enum PackAccess { Read, Write, ReadWrite }

/// <summary>Kiểu dữ liệu của field trong thanh ghi D (mỗi thanh ghi 16 bit). Số word chiếm = <see cref="PackCodec.Words"/>.</summary>
public enum PlcDataType { UInt16, Int16, Bool, UInt32, Int32, Float32, Float64 }

/// <summary>
/// Kết nối tới MỘT PLC theo một giao thức (địa chỉ, cổng, tuỳ chọn mức kết nối). Mọi giá trị đều khai báo rõ — không có "0 = mặc định".
/// Các field của <see cref="ScadaConfig.Pack"/> đã gán giao thức dùng kết nối cùng giao thức này.
/// </summary>
/// <summary>Đọc PlcSource từ cấu hình cũ: giao thức đã gỡ (S7, EtherNet/IP, MC, FINS, ADS, OPC UA) không làm hỏng cả file — trả Gateway (không dùng), bước nâng cấp cấu hình sẽ dọn các kết nối/field đó.</summary>
public sealed class TolerantPlcSourceConverter : System.Text.Json.Serialization.JsonConverter<PlcSource>
{
    public override PlcSource Read(ref System.Text.Json.Utf8JsonReader r, Type t, System.Text.Json.JsonSerializerOptions o)
        => r.TokenType == System.Text.Json.JsonTokenType.String && Enum.TryParse<PlcSource>(r.GetString(), true, out var v) && Enum.IsDefined(v) ? v : PlcSource.Gateway;
    public override void Write(System.Text.Json.Utf8JsonWriter w, PlcSource v, System.Text.Json.JsonSerializerOptions o) => w.WriteStringValue(v.ToString());
}

public sealed class PlcConnection
{
    [JsonConverter(typeof(TolerantPlcSourceConverter))]
    public PlcSource Protocol { get; set; } = PlcSource.ModbusTcp;
    /// <summary>Địa chỉ IP/tên máy (Modbus RTU: tên cổng COM). Beckhoff ADS không dùng (đi qua router ADS theo AmsNetId).</summary>
    public string Host { get; set; } = "";
    /// <summary>Cổng TCP (Modbus RTU: baud).</summary>
    public int Port { get; set; }
    /// <summary>Tuỳ chọn mức kết nối theo <see cref="ProtocolSpec.ConnOptions"/> (OPC UA: path; Modbus RTU: parity).</summary>
    public Dictionary<string, string> Options { get; set; } = new();

    public string Opt(string key) => Options.TryGetValue(key, out var v) ? v : "";
}

/// <summary>Một thông số riêng của giao thức (khoá, nhãn, giá trị gợi ý, danh sách lựa chọn nếu có, hoặc số nguyên).</summary>
/// <param name="Optional">Tuỳ chọn có thể vắng trong cấu hình cũ (không bắt buộc đủ khoá): thêm khoá mới mà không phải di trú cấu hình đã lưu.</param>
public sealed record ParamDef(string Key, string Label, string Default, string[]? Choices = null, bool Int = false, bool Optional = false);

/// <summary>
/// Định nghĩa CHUNG (một nguồn duy nhất) thông số của từng giao thức: dùng để kiểm tra cấu hình, dựng driver và vẽ giao diện.
/// Giá trị Default chỉ là GỢI Ý hiển thị trong ô nhập; cấu hình lưu phải chứa đủ mọi khoá.
/// </summary>
public static class ProtocolSpec
{
    /// <summary>Các giao thức dùng được cho từng luồng (Gateway ESP32 là nguồn khác, không có luồng riêng).</summary>
    public static readonly PlcSource[] Streamable =
    {
        PlcSource.ModbusTcp, PlcSource.ModbusRtu,   // mở rộng giao thức khác sau: thêm vào đây + DriverFactory + Name/Params/SuggestPort
    };

    public static string Name(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp => "Modbus TCP", PlcSource.ModbusRtu => "Modbus RTU (RS485)",
        _ => "Gateway ESP32 (MQTT)",
    };

    /// <summary>Thông số riêng từng luồng (cùng khoá với PlcSim).</summary>
    public static ParamDef[] Params(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp or PlcSource.ModbusRtu => new ParamDef[] { new("unit", "Unit ID (slave)", "1", Int: true) },
        _ => Array.Empty<ParamDef>(),
    };

    /// <summary>Tuỳ chọn mức kết nối.</summary>
    public static ParamDef[] ConnOptions(PlcSource s) => s switch
    {
        PlcSource.ModbusRtu => new ParamDef[]
        {
            new("parity", "Parity", "Even", new[] { "Even", "None", "Odd" }),
            // chỉ board Waveshare dùng (I/O trên board = Unit ID 0): mức DI đổi khi ổn định ≥ số ms này; 0 = tắt lọc
            new("difilter", "Lọc rung DI board (ms, 0 = tắt)", "20", Int: true, Optional: true),
        },
        _ => Array.Empty<ParamDef>(),
    };

    /// <summary>Gợi ý cổng cho ô nhập (cấu hình lưu luôn có cổng rõ ràng).</summary>
    public static int SuggestPort(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp => 502, PlcSource.ModbusRtu => 19200, _ => 1883,
    };

    public static bool UsesHostPort(PlcSource s) => true;

    /// <summary>Kiểm tra mọi khoá thông số đều có mặt và hợp lệ; trả về thông báo lỗi hoặc null.</summary>
    public static string? ValidateParams(PlcSource s, IReadOnlyDictionary<string, string> p, string what, IEnumerable<ParamDef>? defs = null)
    {
        foreach (var d in defs ?? Params(s))
        {
            if (d.Optional && (!p.TryGetValue(d.Key, out var ov) || string.IsNullOrWhiteSpace(ov))) continue;
            if (!p.TryGetValue(d.Key, out var v) || string.IsNullOrWhiteSpace(v)) return $"{what}: thiếu thông số \"{d.Label}\" ({ProtocolSpec.Name(s)}).";
            if (d.Choices != null && !d.Choices.Contains(v)) return $"{what}: \"{d.Label}\" phải là một trong {string.Join(", ", d.Choices)}.";
            if (d.Int && (!int.TryParse(v, out var n) || n < 0)) return $"{what}: \"{d.Label}\" phải là số nguyên không âm.";
        }
        if (s == PlcSource.ModbusRtu && p.TryGetValue("difilter", out var dfv) && int.TryParse(dfv, out var dfn) && dfn > 500) return $"{what}: lọc rung DI tối đa 500 ms.";
        return null;
    }
}

/// <summary>Mã hoá / giải mã giá trị kỹ thuật ↔ các word liền nhau trong thanh ghi D (word cao trước, hoặc thấp trước nếu đảo word).</summary>
public static class PackCodec
{
    public static int Words(PlcDataType t) => t switch { PlcDataType.UInt32 or PlcDataType.Int32 or PlcDataType.Float32 => 2, PlcDataType.Float64 => 4, _ => 1 };

    /// <summary>Mã hoá giá trị thô (đã nhân hệ số). Ném <see cref="ArgumentOutOfRangeException"/> nếu ngoài khoảng của kiểu số nguyên.</summary>
    public static ushort[] Encode(double raw, PlcDataType t, bool swap)
    {
        static double R(double x, double lo, double hi)
        {
            var r = Math.Round(x);
            if (double.IsNaN(r) || r < lo || r > hi) throw new ArgumentOutOfRangeException(nameof(raw), $"{x} ngoài khoảng {lo}…{hi}");
            return r;
        }
        ushort[] w;
        switch (t)
        {
            case PlcDataType.UInt16: w = new[] { (ushort)R(raw, 0, 65535) }; break;
            case PlcDataType.Int16: w = new[] { unchecked((ushort)(short)R(raw, short.MinValue, short.MaxValue)) }; break;
            case PlcDataType.Bool: w = new ushort[] { (ushort)(raw != 0 ? 1 : 0) }; break;
            case PlcDataType.UInt32: { var u = (uint)R(raw, 0, uint.MaxValue); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            case PlcDataType.Int32: { var u = unchecked((uint)(int)R(raw, int.MinValue, int.MaxValue)); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            case PlcDataType.Float32: { var u = BitConverter.SingleToUInt32Bits((float)raw); w = new[] { (ushort)(u >> 16), (ushort)u }; break; }
            default: { var u = BitConverter.DoubleToUInt64Bits(raw); w = new[] { (ushort)(u >> 48), (ushort)(u >> 32), (ushort)(u >> 16), (ushort)u }; break; }
        }
        if (swap && w.Length > 1) Array.Reverse(w);
        return w;
    }

    /// <summary>Giải mã các word (đúng <see cref="Words"/> phần tử) thành giá trị thô.</summary>
    public static double Decode(ReadOnlySpan<ushort> words, PlcDataType t, bool swap)
    {
        var w = words[..Words(t)].ToArray();
        if (swap && w.Length > 1) Array.Reverse(w);
        switch (t)
        {
            case PlcDataType.UInt16: case PlcDataType.Bool: return w[0];
            case PlcDataType.Int16: return unchecked((short)w[0]);
            case PlcDataType.UInt32: return ((uint)w[0] << 16) | w[1];
            case PlcDataType.Int32: return unchecked((int)(((uint)w[0] << 16) | w[1]));
            case PlcDataType.Float32: { var f = BitConverter.UInt32BitsToSingle(((uint)w[0] << 16) | w[1]); return float.IsFinite(f) ? f : 0; }
            default: { var d = BitConverter.UInt64BitsToDouble(((ulong)w[0] << 48) | ((ulong)w[1] << 32) | ((ulong)w[2] << 16) | w[3]); return double.IsFinite(d) ? d : 0; }
        }
    }
}
