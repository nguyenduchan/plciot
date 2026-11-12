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
        // ---- thiết bị công nghiệp bổ sung: Id = mã icon chuẩn (webapp vẽ icon theo mã này, xem webapp/icons.js) ----
        new("fan", "Quạt / thông gió", "✢", "Chạy dừng, đặt tốc độ, dòng điện", "fan", "Quạt", new[]
        {
            new FieldTpl("run", "Quạt", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("speed", "Tốc độ quạt", "slider", "%", 0, 100, 10, true),
            new FieldTpl("a", "Dòng điện", "gauge", "A", 0, 50, 10),
        }),
        new("compressor", "Máy nén khí", "⊚", "Chạy dừng, áp suất, nhiệt độ, giờ chạy", "comp", "Máy nén khí", new[]
        {
            new FieldTpl("run", "Máy nén", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("p", "Áp suất", "gauge", "bar", 0, 16, 100, Low: 4, High: 12),
            new FieldTpl("t", "Nhiệt độ", "gauge", "°C", 0, 150, 10, High: 110),
            new FieldTpl("hours", "Giờ chạy", "number", "h", 0, 100000, 10),
        }),
        new("boiler", "Nồi hơi / lò hơi", "♨", "Chạy dừng, nhiệt độ, áp suất hơi", "boiler", "Nồi hơi", new[]
        {
            new FieldTpl("run", "Nồi hơi", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("t", "Nhiệt độ", "gauge", "°C", 0, 250, 10, High: 200),
            new FieldTpl("p", "Áp suất hơi", "gauge", "bar", 0, 20, 100, High: 16),
        }),
        new("heater", "Gia nhiệt / điện trở", "Ⓗ", "Bật tắt, đặt và đọc nhiệt độ", "heater", "Gia nhiệt", new[]
        {
            new FieldTpl("on", "Gia nhiệt", "toggle", "", 0, 1, 1, true, "Đang nóng", "Tắt"),
            new FieldTpl("sp", "Nhiệt độ đặt", "slider", "°C", 0, 200, 10, true),
            new FieldTpl("t", "Nhiệt độ", "gauge", "°C", 0, 250, 10, High: 220),
        }),
        new("hvac", "Điều hoà / HVAC", "Ⓐ", "Bật tắt, nhiệt độ đặt, nhiệt độ phòng", "hvac", "Điều hoà", new[]
        {
            new FieldTpl("on", "Điều hoà", "toggle", "", 0, 1, 1, true, "Đang chạy", "Tắt"),
            new FieldTpl("sp", "Nhiệt độ đặt", "slider", "°C", 16, 30, 10, true),
            new FieldTpl("t", "Nhiệt độ phòng", "gauge", "°C", 0, 50, 10),
        }),
        new("chiller", "Chiller / làm lạnh", "❄", "Chạy dừng, nhiệt độ nước lạnh", "chiller", "Chiller", new[]
        {
            new FieldTpl("run", "Chiller", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("sp", "Nhiệt độ đặt", "slider", "°C", 0, 20, 10, true),
            new FieldTpl("t", "Nước lạnh", "gauge", "°C", -10, 40, 10),
        }),
        new("vfd", "Biến tần", "∿", "Chạy dừng, tần số đặt, tốc độ, dòng điện", "vfd", "Biến tần", new[]
        {
            new FieldTpl("run", "Biến tần", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("sp", "Tần số đặt", "slider", "Hz", 0, 50, 10, true),
            new FieldTpl("rpm", "Tốc độ", "gauge", "rpm", 0, 3000, 1),
            new FieldTpl("a", "Dòng điện", "gauge", "A", 0, 100, 10),
        }),
        new("generator", "Máy phát điện", "Ⓖ", "Chạy dừng, công suất, điện áp, tần số, nhiên liệu", "gen", "Máy phát", new[]
        {
            new FieldTpl("run", "Máy phát", "toggle", "", 0, 1, 1, true, "Đang chạy", "Dừng"),
            new FieldTpl("kw", "Công suất", "gauge", "kW", 0, 1000, 10),
            new FieldTpl("v", "Điện áp", "gauge", "V", 0, 500, 10),
            new FieldTpl("fuel", "Nhiên liệu", "tank", "%", 0, 100, 10, Low: 15),
        }),
        new("battery", "Ắc quy / UPS", "▮", "Dung lượng, điện áp, dòng sạc/xả", "batt", "Ắc quy / UPS", new[]
        {
            new FieldTpl("soc", "Dung lượng", "tank", "%", 0, 100, 10, Low: 20),
            new FieldTpl("v", "Điện áp", "gauge", "V", 0, 100, 10),
            new FieldTpl("a", "Dòng sạc / xả", "gauge", "A", -100, 100, 10),
        }),
        new("scale", "Cân / loadcell", "⚖", "Khối lượng", "scale", "Cân", new[]
        {
            new FieldTpl("w", "Khối lượng", "gauge", "kg", 0, 1000, 10),
        }),
        new("ph", "pH / chất lượng nước", "⚗", "pH, ORP, nhiệt độ nước", "ph", "pH nước", new[]
        {
            new FieldTpl("ph", "pH", "gauge", "", 0, 14, 100, Low: 6.5, High: 8.5),
            new FieldTpl("orp", "ORP", "gauge", "mV", -500, 1000, 1),
        }),
        new("gas", "Khí / khói / CO₂", "☁", "Nồng độ khí, cảnh báo", "gas", "Cảm biến khí", new[]
        {
            new FieldTpl("ppm", "Nồng độ", "gauge", "ppm", 0, 5000, 1, High: 1000),
        }),
        new("alarm", "Còi / đèn cảnh báo", "⚠", "Bật tắt còi, trạng thái cảnh báo", "alarm", "Cảnh báo", new[]
        {
            new FieldTpl("on", "Còi", "toggle", "", 0, 1, 1, true, "Đang kêu", "Tắt"),
        }),
        new("door", "Cửa / cổng", "▯", "Đóng mở", "door", "Cửa", new[]
        {
            new FieldTpl("open", "Cửa", "toggle", "", 0, 1, 1, true, "Đang mở", "Đóng"),
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
