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
            PlcSource.S7 => new S7Driver(conn.Host, conn.Port, p.Param("cpu"), I("rack"), I("slot"), I("db")),
            PlcSource.EtherNetIp => new EtherNetIpDriver(conn.Host, I("slot"), p.Param("tag")),
            PlcSource.MitsubishiMc => new MitsubishiMcDriver(conn.Host, conn.Port, p.Param("plc")),
            PlcSource.OmronFins => new OmronFinsDriver(conn.Host, conn.Port, p.Param("transport"), I("node"), I("srcnode")),
            PlcSource.BeckhoffAds => new BeckhoffAdsDriver(p.Param("netid"), I("port"), p.Param("symbol")),
            PlcSource.OpcUa => new OpcUaDriver(
                $"opc.tcp://{conn.Host}:{conn.Port}/{conn.Opt("path").TrimStart('/')}",
                $"ns={p.Param("ns")};s={p.Param("image")}", $"ns={p.Param("ns")};s={p.Param("prefix")}{{a}}",
                conn.Opt("security") == "signencrypt", false),
            _ => throw new ArgumentException($"Giao thức không hợp lệ: {p.Protocol}"),
        };
    }

    /// <summary>Tạo driver cho <see cref="ScadaConfig.Source"/>; Gateway không có driver (ESP32 nối vào broker nội bộ).</summary>
    public static IRegisterDriver? Create(ScadaConfig c, ModbusTcpClient? modbusOverride = null) => c.Source switch
    {
        PlcSource.Gateway => null,
        PlcSource.ModbusTcp => modbusOverride ?? new ModbusTcpClient(c.PlcHost, c.PlcPort > 0 ? c.PlcPort : 502, c.ModbusUnit),
        PlcSource.ModbusRtu => ModbusRtuClient.ForSerial(c.PlcHost, c.PlcPort, c.SerialParity, c.ModbusUnit),
        PlcSource.S7 => new S7Driver(c.PlcHost, c.PlcPort, c.S7Cpu, c.S7Rack, c.S7Slot, c.S7Db),
        PlcSource.EtherNetIp => new EtherNetIpDriver(c.PlcHost, c.EipSlot, c.EipTag),
        PlcSource.MitsubishiMc => new MitsubishiMcDriver(c.PlcHost, c.PlcPort, c.McPlcType),
        PlcSource.OmronFins => new OmronFinsDriver(c.PlcHost, c.PlcPort, c.FinsProtocol, c.FinsDestNode, c.FinsSourceNode),
        PlcSource.BeckhoffAds => new BeckhoffAdsDriver(c.AdsNetId, c.AdsPort, c.AdsSymbol),
        PlcSource.OpcUa => new OpcUaDriver(c),
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };
}
