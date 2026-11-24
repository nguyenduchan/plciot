namespace Plciot.Scada.Tests;

/// <summary>Giao thức hiện có: Modbus TCP / RTU (driver riêng đã có test ở ModbusTests). Giao thức khác mở rộng sau: thêm driver + dòng trong DriverFactory + test ở đây.</summary>
public class DriverFactoryTests
{
    [Fact]
    public void Factory_builds_a_driver_for_every_source_except_gateway()
    {
        foreach (var src in Enum.GetValues<PlcSource>())
        {
            var cfg = new ScadaConfig { Source = src, PlcHost = "127.0.0.1" };
            using var d = DriverFactory.Create(cfg) as IDisposable;
            if (src == PlcSource.Gateway) Assert.Null(d); else Assert.NotNull(d);
        }
    }
}
