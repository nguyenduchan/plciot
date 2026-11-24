using GatewayApp;
using Plciot.Scada;

public class ConfigMigrationTests
{
    [Fact]
    public void OldConfigIsUpgradedAndBackedUp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "cfgmig-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "config.json");
        File.WriteAllText(path, "{\"Site\":\"s1\"}");   // file của bản cũ: chưa có ConfigSchema
        var cfg = ConfigStore.Load(path);
        Assert.Equal(0, cfg.ConfigSchema);

        Assert.True(ConfigMigrations.Run(cfg, path));
        Assert.Equal(ConfigMigrations.Current, cfg.ConfigSchema);
        Assert.Equal("s1", cfg.Site);                               // dữ liệu người dùng giữ nguyên
        Assert.Equal("{\"Site\":\"s1\"}", File.ReadAllText(path + ".bak-v0"));   // có bản sao gốc

        Assert.False(ConfigMigrations.Run(cfg, path));              // đã mới: không làm gì
        Directory.Delete(dir, true);
    }

    [Fact]
    public void RemovedProtocolsAreDroppedInsteadOfBreakingTheFile()
    {
        var path = Path.Combine(Path.GetTempPath(), "cfgproto-" + Guid.NewGuid().ToString("N") + ".json");
        // cấu hình cũ: kết nối S7 + OPC UA + Modbus, field gán S7 và Modbus, nguồn chung OpcUa
        File.WriteAllText(path, "{\"Site\":\"s1\",\"Source\":\"OpcUa\",\"ConfigSchema\":1,\"Connections\":[{\"Protocol\":\"S7\",\"Host\":\"a\"},{\"Protocol\":\"ModbusTcp\",\"Host\":\"b\",\"Port\":502},{\"Protocol\":\"OpcUa\",\"Host\":\"c\"}]," +
            "\"Pack\":[{\"Child\":\"p\",\"Field\":\"x\",\"Address\":1,\"Scale\":1,\"Protocol\":\"S7\"},{\"Child\":\"q\",\"Field\":\"y\",\"Address\":2,\"Scale\":1,\"Protocol\":\"ModbusTcp\"}]}");
        var cfg = ConfigStore.Load(path);                                   // không ném lỗi dù có giá trị enum đã gỡ
        Assert.True(ConfigMigrations.Run(cfg, path));
        Assert.Single(cfg.Connections); Assert.Equal(PlcSource.ModbusTcp, cfg.Connections[0].Protocol);
        Assert.Single(cfg.Pack); Assert.Equal("q", cfg.Pack[0].Child);
        File.Delete(path); File.Delete(path + ".bak-v1");
    }

    [Fact]
    public void UnreadableConfigIsKept()
    {
        var path = Path.Combine(Path.GetTempPath(), "cfgbad-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, "{hong");
        ConfigMigrations.BackupUnreadable(path);
        Assert.Equal("{hong", File.ReadAllText(path + ".bad"));
        File.Delete(path); File.Delete(path + ".bad");
    }
}
