namespace Plciot.Scada;

public static class DriverFactory
{
    /// <summary>Tạo driver cho MỘT field đã gán giao thức: kết nối lấy từ <paramref name="conn"/>, thông số từ <see cref="PackMap.Params"/>. Không có giá trị ngầm định.</summary>
    public static IRegisterDriver CreateFor(PlcConnection conn, PackMap p)
    {
        int I(string k) => int.Parse(p.Param(k));
        return p.Source switch
        {
            PlcSource.ModbusTcp => new ModbusTcpClient(conn.Host, conn.Port, I("unit")),
            PlcSource.ModbusRtu => ModbusRtuClient.ForSerial(conn.Host, conn.Port, conn.Opt("parity"), I("unit")),
            _ => throw new ArgumentException($"Giao thức không hợp lệ: {p.Protocol}"),
        };
    }

    /// <summary>Tạo driver cho <see cref="ScadaConfig.Source"/>; Gateway không có driver (ESP32 nối vào broker nội bộ).</summary>
    public static IRegisterDriver? Create(ScadaConfig c, ModbusTcpClient? modbusOverride = null) => c.Source switch
    {
        PlcSource.Gateway => null,
        PlcSource.ModbusTcp => modbusOverride ?? new ModbusTcpClient(c.PlcHost, c.PlcPort > 0 ? c.PlcPort : 502, c.ModbusUnit),
        PlcSource.ModbusRtu => ModbusRtuClient.ForSerial(c.PlcHost, c.PlcPort, c.SerialParity, c.ModbusUnit),
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };
}
