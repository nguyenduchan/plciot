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
    public void UnreadableConfigIsKept()
    {
        var path = Path.Combine(Path.GetTempPath(), "cfgbad-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, "{hong");
        ConfigMigrations.BackupUnreadable(path);
        Assert.Equal("{hong", File.ReadAllText(path + ".bad"));
        File.Delete(path); File.Delete(path + ".bad");
    }
}
