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
public sealed class PlcConnection
{
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public PlcSource Protocol { get; set; } = PlcSource.ModbusTcp;
    /// <summary>Địa chỉ IP/tên máy (Modbus RTU: tên cổng COM). Beckhoff ADS không dùng (đi qua router ADS theo AmsNetId).</summary>
    public string Host { get; set; } = "";
    /// <summary>Cổng TCP/UDP (Modbus RTU: baud). Beckhoff ADS không dùng; EtherNet/IP do thư viện libplctag cố định 44818.</summary>
    public int Port { get; set; }
    /// <summary>Tuỳ chọn mức kết nối theo <see cref="ProtocolSpec.ConnOptions"/> (OPC UA: path; Modbus RTU: parity).</summary>
    public Dictionary<string, string> Options { get; set; } = new();

    public string Opt(string key) => Options.TryGetValue(key, out var v) ? v : "";
}

/// <summary>Một thông số riêng của giao thức (khoá, nhãn, giá trị gợi ý, danh sách lựa chọn nếu có, hoặc số nguyên).</summary>
public sealed record ParamDef(string Key, string Label, string Default, string[]? Choices = null, bool Int = false);

/// <summary>
/// Định nghĩa CHUNG (một nguồn duy nhất) thông số của từng giao thức: dùng để kiểm tra cấu hình, dựng driver và vẽ giao diện.
/// Giá trị Default chỉ là GỢI Ý hiển thị trong ô nhập; cấu hình lưu phải chứa đủ mọi khoá.
/// </summary>
public static class ProtocolSpec
{
    /// <summary>Các giao thức dùng được cho từng luồng (Gateway ESP32 là nguồn khác, không có luồng riêng).</summary>
    public static readonly PlcSource[] Streamable =
    {
        PlcSource.ModbusTcp, PlcSource.ModbusRtu, PlcSource.S7, PlcSource.EtherNetIp, PlcSource.MitsubishiMc, PlcSource.OmronFins, PlcSource.BeckhoffAds, PlcSource.OpcUa,
    };

    public static string Name(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp => "Modbus TCP", PlcSource.ModbusRtu => "Modbus RTU (RS485)", PlcSource.S7 => "Siemens S7", PlcSource.EtherNetIp => "EtherNet/IP",
        PlcSource.MitsubishiMc => "Mitsubishi MC 3E", PlcSource.OmronFins => "Omron FINS", PlcSource.BeckhoffAds => "Beckhoff ADS", PlcSource.OpcUa => "OPC UA",
        _ => "Gateway ESP32 (MQTT)",
    };

    public static readonly string[] S7Cpus = { "S7200", "S7300", "S7400", "S71200", "S71500" };
    public static readonly string[] McTypes = { "Q", "L", "QnA", "iQ-R", "iQ-L" };

    /// <summary>Thông số riêng từng luồng (cùng khoá với PlcSim).</summary>
    public static ParamDef[] Params(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp or PlcSource.ModbusRtu => new ParamDef[] { new("unit", "Unit ID (slave)", "1", Int: true) },
        PlcSource.S7 => new ParamDef[] { new("cpu", "CPU", "S71500", S7Cpus), new("rack", "Rack", "0", Int: true), new("slot", "Slot", "1", Int: true), new("db", "Số DB", "1", Int: true) },
        PlcSource.EtherNetIp => new ParamDef[] { new("tag", "Tên tag (INT[])", "PLC_D"), new("slot", "Slot CPU", "0", Int: true) },
        PlcSource.MitsubishiMc => new ParamDef[] { new("plc", "Dòng PLC", "Q", McTypes) },
        PlcSource.OmronFins => new ParamDef[] { new("transport", "Giao vận", "udp", new[] { "udp", "tcp" }), new("node", "Node đích (DA1)", "1", Int: true), new("srcnode", "Node nguồn (SA1)", "0", Int: true) },
        PlcSource.BeckhoffAds => new ParamDef[] { new("netid", "AMS NetId", "127.0.0.1.1.1"), new("port", "AMS port", "851", Int: true), new("symbol", "Symbol (INT[])", "GVL_PLC.D") },
        PlcSource.OpcUa => new ParamDef[] { new("ns", "Namespace index", "2", Int: true), new("image", "Node ảnh thanh ghi", "PLC_D"), new("prefix", "Tiền tố node ghi", "PLC_W") },
        _ => Array.Empty<ParamDef>(),
    };

    /// <summary>Tuỳ chọn mức kết nối.</summary>
    public static ParamDef[] ConnOptions(PlcSource s) => s switch
    {
        PlcSource.OpcUa => new ParamDef[] { new("path", "Đường dẫn endpoint", "plcsim"), new("security", "Bảo mật", "none", new[] { "none", "signencrypt" }) },
        PlcSource.ModbusRtu => new ParamDef[] { new("parity", "Parity", "Even", new[] { "Even", "None", "Odd" }) },
        _ => Array.Empty<ParamDef>(),
    };

    /// <summary>Gợi ý cổng cho ô nhập (cấu hình lưu luôn có cổng rõ ràng).</summary>
    public static int SuggestPort(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp => 502, PlcSource.ModbusRtu => 19200, PlcSource.S7 => 102, PlcSource.EtherNetIp => 44818, PlcSource.MitsubishiMc => 5001,
        PlcSource.OmronFins => 9600, PlcSource.OpcUa => 4840, PlcSource.BeckhoffAds => 48898, _ => 1883,
    };

    public static bool UsesHostPort(PlcSource s) => s != PlcSource.BeckhoffAds;

    /// <summary>Kiểm tra mọi khoá thông số đều có mặt và hợp lệ; trả về thông báo lỗi hoặc null.</summary>
    public static string? ValidateParams(PlcSource s, IReadOnlyDictionary<string, string> p, string what, IEnumerable<ParamDef>? defs = null)
    {
        foreach (var d in defs ?? Params(s))
        {
            if (!p.TryGetValue(d.Key, out var v) || string.IsNullOrWhiteSpace(v)) return $"{what}: thiếu thông số \"{d.Label}\" ({ProtocolSpec.Name(s)}).";
            if (d.Choices != null && !d.Choices.Contains(v)) return $"{what}: \"{d.Label}\" phải là một trong {string.Join(", ", d.Choices)}.";
            if (d.Int && (!int.TryParse(v, out var n) || n < 0)) return $"{what}: \"{d.Label}\" phải là số nguyên không âm.";
        }
        if (s == PlcSource.OmronFins && int.TryParse(p["node"], out var node) && (node < 1 || node > 254)) return $"{what}: node đích FINS phải từ 1 đến 254.";
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
