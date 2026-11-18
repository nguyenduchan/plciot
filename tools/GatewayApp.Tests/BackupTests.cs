using GatewayApp;
using Plciot.Scada;

public class BackupTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "gwbk-" + Guid.NewGuid().ToString("N"));
    string Settings => Path.Combine(_dir, "gateway-app", "config.json");

    public BackupTests() { Directory.CreateDirectory(Path.GetDirectoryName(Settings)!); }
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    BackupService Svc(int schema = 1, string machine = "MACHINE-A") => new(Settings, _dir, "v-test", schema, machine);

    void Seed()
    {
        ConfigStore.Save(Settings, new ScadaConfig { Site = "nhamay1", CloudPassword = "S3cretPass!", GatewayKey = "PRIVATE-KEY-XYZ", ConfigSchema = 1 });
        File.WriteAllText(Path.ChangeExtension(Settings, ".ui.json"), "{\"nhan\":\"Bơm 1\"}");
        File.WriteAllText(Path.ChangeExtension(Settings, ".lock.json"), "15");
    }

    [Fact]
    public void RoundTripRestoresEverythingAndHidesSecrets()
    {
        Seed();
        var s = Svc();
        var shown = s.CreateKey();
        Assert.Matches(@"^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$", shown);
        var info = s.Create("manual");

        // gói không chứa bí mật ở dạng đọc được
        var bytes = File.ReadAllBytes(info.Path);
        Assert.DoesNotContain("S3cretPass!", System.Text.Encoding.UTF8.GetString(bytes));
        Assert.DoesNotContain("PRIVATE-KEY-XYZ", System.Text.Encoding.UTF8.GetString(bytes));

        File.Delete(Settings); File.Delete(Path.ChangeExtension(Settings, ".ui.json")); File.Delete(Path.ChangeExtension(Settings, ".lock.json"));
        var r = s.Restore(info.Path, shown.ToLowerInvariant().Replace("-", " "), apply: true);   // khoá gõ lại tuỳ ý hoa/thường/dấu cách
        Assert.True(r.Ok, r.Error);
        var cfg = ConfigStore.Load(Settings);
        Assert.Equal("nhamay1", cfg.Site);
        Assert.Equal("S3cretPass!", cfg.CloudPassword);
        Assert.Equal("PRIVATE-KEY-XYZ", cfg.GatewayKey);
        Assert.Contains("Bơm 1", File.ReadAllText(Path.ChangeExtension(Settings, ".ui.json")));
        Assert.Equal("15", File.ReadAllText(Path.ChangeExtension(Settings, ".lock.json")));
        Assert.DoesNotContain("S3cretPass!", File.ReadAllText(Settings));   // trên đĩa vẫn được mã hoá DPAPI của máy
    }

    [Fact]
    public void WrongKeyIsRejectedAndNothingChanges()
    {
        Seed();
        var s = Svc(); s.CreateKey();
        var info = s.Create("manual");
        File.WriteAllText(Path.ChangeExtension(Settings, ".lock.json"), "99");
        var r = s.Restore(info.Path, "AAAAA-AAAAA-AAAAA-AAAAA", apply: true);
        Assert.False(r.Ok);
        Assert.Contains("Sai khoá", r.Error);
        Assert.Equal("99", File.ReadAllText(Path.ChangeExtension(Settings, ".lock.json")));
    }

    [Fact]
    public void TamperedBundleIsRejected()
    {
        Seed();
        var s = Svc(); var key = s.CreateKey();
        var info = s.Create("manual");
        var b = File.ReadAllBytes(info.Path);
        b[b.Length / 2] ^= 0xFF;   // lật một bit giữa file
        File.WriteAllBytes(info.Path, b);
        var r = s.Restore(info.Path, key, apply: false);
        Assert.False(r.Ok);
    }

    [Fact]
    public void BundleFromNewerConfigSchemaIsRefused()
    {
        Seed();
        var newer = Svc(schema: 5); var key = newer.CreateKey();
        var info = newer.Create("manual");
        var older = Svc(schema: 1);
        var r = older.Restore(info.Path, key, apply: false);
        Assert.False(r.Ok);
        Assert.Contains("mới hơn", r.Error);
    }

    [Fact]
    public void BundleFromOtherMachineIsFlagged()
    {
        Seed();
        var a = Svc(machine: "MACHINE-A"); var key = a.CreateKey();
        var info = a.Create("manual");
        var r = Svc(machine: "MACHINE-B").Restore(info.Path, key, apply: false);   // máy khác dùng đúng khoá khôi phục
        Assert.True(r.Ok, r.Error);
        Assert.True(r.OtherMachine);
    }

    [Fact]
    public void RestoreMakesPreRestoreSafetyBackup()
    {
        Seed();
        var s = Svc(); var key = s.CreateKey();
        var info = s.Create("manual");
        Assert.DoesNotContain(s.List(), i => i.Reason == "pre-restore");
        Assert.True(s.Restore(info.Path, key, apply: true).Ok);
        Assert.Contains(s.List(), i => i.Reason == "pre-restore");
    }

    [Fact]
    public void ExtraFolderGetsACopy()
    {
        Seed();
        var s = Svc(); s.CreateKey();
        var extra = Path.Combine(_dir, "usb"); s.ExtraDir = extra;
        var info = s.Create("manual");
        Assert.True(File.Exists(Path.Combine(extra, info.Name)));
        Assert.Null(s.LastExtraError);
    }

    [Fact]
    public void AutoDueOnlyWhenNoBackupInLast24h()
    {
        Seed();
        var s = Svc();
        Assert.False(s.AutoDue(DateTime.Now));   // chưa có khoá → chưa tự sao lưu
        s.CreateKey();
        Assert.True(s.AutoDue(DateTime.Now));
        s.Create("auto");
        Assert.False(s.AutoDue(DateTime.Now));
        Assert.True(s.AutoDue(DateTime.Now.AddHours(25)));
    }

    [Fact]
    public void PruneKeepsDailyWeeklyAndLimitedOthers()
    {
        var now = new DateTime(2026, 11, 18, 12, 0, 0);
        var items = new List<(string, DateTime, string)>();
        for (var d = 0; d < 60; d++) { items.Add(($"a{d}-1", now.AddDays(-d), "auto")); items.Add(($"a{d}-0", now.AddDays(-d).AddHours(-5), "auto")); }   // 2 bản/ngày suốt 60 ngày
        for (var i = 0; i < 15; i++) items.Add(($"m{i}", now.AddMinutes(-i), "manual"));
        for (var i = 0; i < 6; i++) items.Add(($"u{i}", now.AddHours(-i), "pre-update"));
        var del = BackupService.PruneList(items, now).ToHashSet();
        var kept = items.Select(i => i.Item1).Where(n => !del.Contains(n)).ToList();

        Assert.Equal(7, kept.Count(n => n.StartsWith("a") && int.Parse(n[1..n.IndexOf('-')]) < 7));      // 7 ngày gần nhất: mỗi ngày 1 bản
        Assert.All(Enumerable.Range(0, 7), d => Assert.Contains($"a{d}-1", kept));                         // và là bản mới nhất của ngày
        Assert.Equal(4, kept.Count(n => n.StartsWith("a") && int.Parse(n[1..n.IndexOf('-')]) >= 7));      // 4 tuần kế tiếp: mỗi tuần 1 bản
        Assert.Equal(10, kept.Count(n => n.StartsWith("m")));
        Assert.Equal(3, kept.Count(n => n.StartsWith("u")));
    }
}
