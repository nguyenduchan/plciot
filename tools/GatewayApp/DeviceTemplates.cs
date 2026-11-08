using Plciot.Scada;

namespace GatewayApp;

/// <summary>Một field của mẫu thiết bị: tên, nhãn tiếng Việt, kiểu hiển thị, đơn vị, khoảng, hệ số, chữ trạng thái.</summary>
public sealed record FieldTpl(
    string Field, string Label, string Kind, string Unit = "", double Min = 0, double Max = 100, double Scale = 10,
    bool Writable = false, string On = "", string Off = "", double? Low = null, double? High = null);

/// <summary>Mẫu theo loại thiết bị vật lý: chọn mẫu → có sẵn các field, nhãn, đơn vị, chữ trạng thái đúng loại.</summary>
public sealed record DeviceTemplate(string Id, string Name, string Icon, string Desc, string IdPrefix, string DefaultTitle, FieldTpl[] Fields)
{
    public static readonly DeviceTemplate[] All =
    {
        new("tank", "Bồn nước / cảm biến mức", "≋", "Đo mực chất lỏng, cảnh báo thấp / cao", "tank", "Bồn nước", new[]
        {
            new FieldTpl("level", "Mức nước", "tank", "%", 0, 100, 10, Low: 15, High: 92),
        }),
        new("pump", "Bơm (chạy / dừng, đặt tốc độ)", "◉", "Bật tắt, đặt tốc độ, lưu lượng, giờ chạy", "pump", "Bơm nước", new[]
        {
            new FieldTpl("run", "Bơm", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("speed", "Tốc độ bơm", "slider", "%", 0, 100, 10, true),
            new FieldTpl("flow", "Lưu lượng", "gauge", "L/phút", 0, 100, 10),
            new FieldTpl("hours", "Giờ chạy", "number", "h", 0, 100000, 10),
        }),
        new("env", "Cảm biến nhiệt độ / độ ẩm", "☀", "Nhiệt độ và độ ẩm môi trường", "env", "Nhiệt độ / độ ẩm", new[]
        {
            new FieldTpl("t", "Nhiệt độ", "gauge", "°C", 0, 100, 10),
            new FieldTpl("h", "Độ ẩm", "gauge", "%", 0, 100, 10),
        }),
        new("valve", "Van / relay / contactor", "⏻", "Đóng cắt một tiếp điểm", "valve", "Van", new[]
        {
            new FieldTpl("on", "Trạng thái van", "toggle", "", 0, 1, 1, true, "Mở", "Đóng"),
        }),
        new("motor", "Động cơ / biến tần", "⚙", "Chạy dừng, đặt tần số, tốc độ vòng quay, dòng điện", "motor", "Động cơ", new[]
        {
            new FieldTpl("run", "Động cơ", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("sp", "Tần số đặt", "slider", "Hz", 0, 50, 10, true),
            new FieldTpl("rpm", "Tốc độ", "gauge", "rpm", 0, 3000, 1),
            new FieldTpl("a", "Dòng điện", "gauge", "A", 0, 50, 10),
        }),
        new("energy", "Đồng hồ điện năng", "ϟ", "Công suất, điện áp, dòng, điện năng tiêu thụ", "meter", "Điện năng", new[]
        {
            new FieldTpl("kw", "Công suất", "gauge", "kW", 0, 100, 10),
            new FieldTpl("v", "Điện áp", "gauge", "V", 0, 500, 10),
            new FieldTpl("a", "Dòng điện", "gauge", "A", 0, 200, 10),
            new FieldTpl("kwh", "Điện năng", "number", "kWh", 0, 1000000, 10),
        }),
        new("pressure", "Cảm biến áp suất", "⌀", "Áp suất đường ống / bình", "press", "Áp suất", new[]
        {
            new FieldTpl("p", "Áp suất", "gauge", "bar", 0, 10, 100),
        }),
        new("conveyor", "Băng tải / đếm sản phẩm", "▭", "Chạy dừng, đếm số lượng, tốc độ", "conv", "Băng tải", new[]
        {
            new FieldTpl("run", "Băng tải", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("count", "Số sản phẩm", "number", "cái", 0, 1000000, 1),
            new FieldTpl("speed", "Tốc độ", "slider", "%", 0, 100, 10, true),
        }),
        new("di", "Đầu vào số (nút nhấn, công tắc hành trình)", "⬇", "Đọc trạng thái 0 / 1", "di", "Đầu vào số", new[]
        {
            new FieldTpl("in", "Tín hiệu vào", "number", "", 0, 1, 1),
        }),
        new("do", "Đầu ra số (đèn, còi)", "⬆", "Điều khiển 0 / 1", "do", "Đầu ra số", new[]
        {
            new FieldTpl("out", "Tín hiệu ra", "toggle", "", 0, 1, 1, true, "Bật", "Tắt"),
        }),
        new("custom", "Tuỳ chọn", "＋", "Tự khai báo từng field", "dev", "Thiết bị mới", new[]
        {
            new FieldTpl("v1", "Giá trị 1", "number", "", 0, 100, 10),
        }),
    };

    public static DeviceTemplate? Find(string id) => All.FirstOrDefault(t => t.Id == id);

    /// <summary>Giải thích cách số D được hiểu theo giao thức đang dùng (để nhập đúng địa chỉ).</summary>
    public static string AddressHint(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp or PlcSource.ModbusRtu => "Modbus: D n = thanh ghi giữ (holding register) số n của trạm.",
        PlcSource.S7 => "Siemens S7: D n = DBW(2·n) trong DB đã chọn (INT[300]).",
        PlcSource.EtherNetIp => "EtherNet/IP: D n = phần tử [n] của tag INT[300].",
        PlcSource.MitsubishiMc => "Mitsubishi MC: D n = thiết bị D n.",
        PlcSource.OmronFins => "Omron FINS: D n = vùng DM, ô DM n.",
        PlcSource.BeckhoffAds => "Beckhoff ADS: D n = phần tử [n] của symbol ARRAY[0..299] OF INT.",
        PlcSource.OpcUa => "OPC UA: D n = phần tử [n] của node ảnh thanh ghi (UInt16[300]); ghi qua node PLC_W{n}.",
        _ => "Gateway ESP32: D n là thanh ghi D n của PLC phía sau ESP32.",
    };

    public static string ProtocolName(PlcSource s) => s switch
    {
        PlcSource.ModbusTcp => "Modbus TCP", PlcSource.ModbusRtu => "Modbus RTU", PlcSource.S7 => "Siemens S7", PlcSource.EtherNetIp => "EtherNet/IP",
        PlcSource.MitsubishiMc => "Mitsubishi MC", PlcSource.OmronFins => "Omron FINS", PlcSource.BeckhoffAds => "Beckhoff ADS", PlcSource.OpcUa => "OPC UA", _ => "Gateway ESP32",
    };
}
