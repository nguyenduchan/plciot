namespace Plciot.Scada;

public static class DriverFactory
{
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
