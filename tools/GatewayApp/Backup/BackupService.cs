using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>Một bản sao lưu trong thư mục backups (đọc từ manifest).</summary>
sealed record BackupInfo(string Path, DateTime At, string Reason, string AppVersion, int ConfigSchema, string MachineId, long Size)
{
    public string Name => System.IO.Path.GetFileName(Path);
}

sealed record RestoreResult(bool Ok, string? Error, BackupInfo? Info, ScadaConfig? Config, bool OtherMachine);

/// <summary>
/// Sao lưu / khôi phục dữ liệu của gateway (cấu hình, nhãn giao diện, cài đặt khoá).
/// Gói <c>.gwbackup</c> = zip gồm <c>manifest.json</c> (thông tin + sha256 từng file) và <c>files/&lt;tên&gt;.enc</c>.
/// Mọi file được mã hoá AES-256-GCM bằng khoá dẫn xuất (PBKDF2-SHA256) từ KHOÁ KHÔI PHỤC — KHÔNG dùng DPAPI của máy,
/// nên gói khôi phục được sang máy khác (bí mật như khoá riêng gateway được mã hoá lại bằng DPAPI của máy mới lúc khôi phục).
/// Khoá khôi phục tự sinh một lần, người dùng cất ngoài máy (như "emergency kit" của Home Assistant); máy giữ thêm một bản (DPAPI) để sao lưu tự động.
/// Không có khoá thì không đọc được gói.
/// </summary>
sealed class BackupService
{
    public const int Format = 1;
    const int Iterations = 200_000;
    const string Ext = ".gwbackup";
    public static readonly string[] Reasons = { "auto", "manual", "pre-update", "pre-restore" };

    readonly string _settings, _dataDir, _appVersion, _machineId;
    readonly int _schema;
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public BackupService(string settingsPath, string dataDir, string appVersion, int configSchema, string machineId)
    {
        _settings = settingsPath; _dataDir = dataDir; _appVersion = appVersion; _schema = configSchema; _machineId = machineId;
    }

    public string BackupDir => Path.Combine(_dataDir, "backups");
    string KeyPath => Path.Combine(_dataDir, "backup-key.dat");
    string SettingsFile => Path.Combine(_dataDir, "backup-settings.json");

    /// <summary>File dữ liệu được sao lưu: tên trong gói → đường dẫn thật.</summary>
    Dictionary<string, string> Sources() => new()
    {
        ["config.json"] = _settings,
        ["ui.json"] = Path.ChangeExtension(_settings, ".ui.json"),
        ["lock.json"] = Path.ChangeExtension(_settings, ".lock.json"),
    };

    // ------------------------------------------------------------------ khoá khôi phục
    public bool HasKey => File.Exists(KeyPath);

    /// <summary>Sinh khoá khôi phục mới (20 ký tự, hiển thị XXXXX-XXXXX-XXXXX-XXXXX), lưu bản mã hoá DPAPI trên máy này, trả bản hiển thị để người dùng cất.</summary>
    public string CreateKey()
    {
        const string A = "ABCDEFGHJKMNPQRSTVWXYZ23456789";   // bỏ ký tự dễ nhầm (I L O U 0 1)
        var bytes = RandomNumberGenerator.GetBytes(20);
        var sb = new StringBuilder();
        for (var i = 0; i < 20; i++) { if (i > 0 && i % 5 == 0) sb.Append('-'); sb.Append(A[bytes[i] % A.Length]); }
        var key = sb.ToString();
        Directory.CreateDirectory(_dataDir);
        var enc = OperatingSystem.IsWindows() ? ProtectedData.Protect(Encoding.UTF8.GetBytes(key), null, DataProtectionScope.LocalMachine) : Encoding.UTF8.GetBytes(key);
        File.WriteAllBytes(KeyPath, enc);
        return key;
    }

    /// <summary>Khoá lưu trên máy này (null nếu chưa có hoặc không giải mã được, vd. file chép từ máy khác).</summary>
    public string? LoadKey()
    {
        try
        {
            if (!File.Exists(KeyPath)) return null;
            var raw = File.ReadAllBytes(KeyPath);
            return Encoding.UTF8.GetString(OperatingSystem.IsWindows() ? ProtectedData.Unprotect(raw, null, DataProtectionScope.LocalMachine) : raw);
        }
        catch (Exception e) when (e is CryptographicException or IOException) { return null; }
    }

    /// <summary>Chuẩn hoá khoá người dùng gõ: bỏ khoảng trắng/gạch, viết hoa.</summary>
    public static string NormalizeKey(string s) => new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();

    // ------------------------------------------------------------------ thư mục thứ hai (USB / ổ mạng)
    public string ExtraDir
    {
        get { try { return File.Exists(SettingsFile) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(SettingsFile))?.GetValueOrDefault("extraDir") ?? "" : ""; } catch { return ""; } }
        set { Directory.CreateDirectory(_dataDir); File.WriteAllText(SettingsFile, JsonSerializer.Serialize(new Dictionary<string, string> { ["extraDir"] = value ?? "" })); }
    }

    // ------------------------------------------------------------------ tạo
    /// <summary>Tạo gói mới (cấu hình lấy từ file trên đĩa — gọi SaveCfg trước nếu cần). Có thư mục thứ hai thì chép thêm một bản. Ném lỗi nếu chưa có khoá hoặc không ghi được.</summary>
    public BackupInfo Create(string reason, DateTime? now = null)
    {
        var key = LoadKey() ?? throw new InvalidOperationException("chưa có khoá khôi phục");
        var at = now ?? DateTime.Now;
        var salt = RandomNumberGenerator.GetBytes(16);
        var aes = DeriveKey(key, salt);
        var files = new List<object>();
        Directory.CreateDirectory(BackupDir);
        var final = Path.Combine(BackupDir, $"GatewayBackup-{at:yyyyMMdd-HHmmss}-{reason}{Ext}");
        var tmp = final + ".tmp";
        using (var fs = File.Create(tmp))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            foreach (var (name, path) in Sources())
            {
                var plain = ReadPlain(name, path);
                if (plain == null) continue;
                var e = zip.CreateEntry($"files/{name}.enc", CompressionLevel.Optimal);
                using (var es = e.Open()) { var blob = Encrypt(aes, plain); es.Write(blob, 0, blob.Length); }
                files.Add(new { name, sha256 = Convert.ToHexString(SHA256.HashData(plain)).ToLowerInvariant(), size = plain.Length });
            }
            var man = new
            {
                format = Format, createdAt = at.ToString("o"), reason, appVersion = _appVersion, configSchema = _schema, machineId = _machineId,
                kdf = new { name = "pbkdf2-sha256", iterations = Iterations, salt = Convert.ToBase64String(salt) }, files,
            };
            var me = zip.CreateEntry("manifest.json");
            using var ms = me.Open(); var mb = JsonSerializer.SerializeToUtf8Bytes(man, Json); ms.Write(mb, 0, mb.Length);
        }
        File.Move(tmp, final, overwrite: true);
        TryCopyExtra(final);
        Prune();
        return Read(final) ?? throw new IOException("không đọc lại được bản sao lưu vừa tạo");
    }

    /// <summary>Nội dung file ở dạng KHÔNG mã hoá máy: config.json giải mã DPAPI rồi serialize lại (bí mật nằm trong gói, được mã hoá bằng khoá khôi phục).</summary>
    byte[]? ReadPlain(string name, string path)
    {
        if (!File.Exists(path)) return null;
        if (name != "config.json") return File.ReadAllBytes(path);
        var cfg = ConfigStore.Load(path);
        return JsonSerializer.SerializeToUtf8Bytes(cfg, Json);
    }

    void TryCopyExtra(string file)
    {
        try
        {
            var d = ExtraDir;
            if (string.IsNullOrWhiteSpace(d)) return;
            Directory.CreateDirectory(d);
            File.Copy(file, Path.Combine(d, Path.GetFileName(file)), true);
            PruneDir(d);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { LastExtraError = e.Message; }
    }

    /// <summary>Lỗi chép sang thư mục thứ hai lần gần nhất (null = ổn).</summary>
    public string? LastExtraError { get; private set; }

    // ------------------------------------------------------------------ danh sách / giữ lại
    public static BackupInfo? Read(string path)
    {
        try
        {
            using var z = ZipFile.OpenRead(path);
            using var s = z.GetEntry("manifest.json")!.Open();
            using var d = JsonDocument.Parse(s);
            var r = d.RootElement;
            return new BackupInfo(path, DateTime.Parse(r.GetProperty("createdAt").GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind).ToLocalTime(),
                r.GetProperty("reason").GetString() ?? "manual", r.GetProperty("appVersion").GetString() ?? "", r.GetProperty("configSchema").GetInt32(),
                r.GetProperty("machineId").GetString() ?? "", new FileInfo(path).Length);
        }
        catch { return null; }
    }

    public List<BackupInfo> List() => ListDir(BackupDir);

    public static List<BackupInfo> ListDir(string dir) =>
        !Directory.Exists(dir) ? new() : Directory.GetFiles(dir, "*" + Ext).Select(Read).Where(i => i != null).Select(i => i!).OrderByDescending(i => i.At).ToList();

    public DateTime? LastBackupAt => List().FirstOrDefault()?.At;

    /// <summary>Tới hạn sao lưu tự động: có khoá và chưa có bản "auto" nào trong 24 giờ qua.</summary>
    public bool AutoDue(DateTime now) => HasKey && !List().Any(i => i.Reason == "auto" && now - i.At < TimeSpan.FromHours(24));

    public void Prune() { PruneDir(BackupDir); }

    void PruneDir(string dir)
    {
        try { foreach (var f in PruneList(ListDir(dir).Select(i => (i.Path, i.At, i.Reason)), DateTime.Now)) File.Delete(f); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>
    /// Giữ: auto = bản mới nhất của mỗi ngày trong 7 ngày + bản mới nhất của mỗi tuần trong 4 tuần kế tiếp; manual = 10 bản mới nhất;
    /// pre-update và pre-restore = 3 bản mới nhất mỗi loại. Trả danh sách đường dẫn cần xoá.
    /// </summary>
    public static List<string> PruneList(IEnumerable<(string Path, DateTime At, string Reason)> items, DateTime now)
    {
        var all = items.OrderByDescending(i => i.At).ToList();
        var keep = new HashSet<string>();
        var auto = all.Where(i => i.Reason == "auto").ToList();
        var today = now.Date;
        foreach (var g in auto.Where(i => (today - i.At.Date).Days < 7).GroupBy(i => i.At.Date)) keep.Add(g.First().Path);
        foreach (var g in auto.Where(i => (today - i.At.Date).Days is >= 7 and < 35).GroupBy(i => (today - i.At.Date).Days / 7)) keep.Add(g.First().Path);
        foreach (var i in all.Where(i => i.Reason == "manual").Take(10)) keep.Add(i.Path);
        foreach (var r in new[] { "pre-update", "pre-restore" }) foreach (var i in all.Where(i => i.Reason == r).Take(3)) keep.Add(i.Path);
        foreach (var i in all.Where(i => !Reasons.Contains(i.Reason))) keep.Add(i.Path);   // loại lạ (bản mới hơn tạo): không đụng
        return all.Where(i => !keep.Contains(i.Path)).Select(i => i.Path).ToList();
    }

    // ------------------------------------------------------------------ khôi phục
    /// <summary>
    /// Kiểm gói bằng <paramref name="key"/> (giải mã + sha256 từng file, schema không mới hơn app). <paramref name="apply"/>=true: ghi đè dữ liệu hiện tại
    /// (trước đó tự tạo bản "pre-restore" nếu máy có khoá). Cấu hình được nâng schema nếu cũ và mã hoá lại bằng DPAPI của máy này.
    /// </summary>
    public RestoreResult Restore(string file, string key, bool apply)
    {
        BackupInfo? info = Read(file);
        if (info == null) return new(false, "Không đọc được file sao lưu (hỏng hoặc không phải gói sao lưu).", null, null, false);
        try
        {
            using var z = ZipFile.OpenRead(file);
            using var md = JsonDocument.Parse(z.GetEntry("manifest.json")!.Open());
            var m = md.RootElement;
            if (m.GetProperty("format").GetInt32() > Format) return new(false, "Gói sao lưu do phiên bản gateway mới hơn tạo ra — hãy cập nhật gateway trước.", info, null, false);
            if (info.ConfigSchema > _schema) return new(false, $"Gói sao lưu có định dạng cấu hình v{info.ConfigSchema} mới hơn bản gateway này (v{_schema}) — hãy cập nhật gateway trước.", info, null, false);
            var kdf = m.GetProperty("kdf");
            var aes = DeriveKey(NormalizeKey(key), Convert.FromBase64String(kdf.GetProperty("salt").GetString()!), kdf.GetProperty("iterations").GetInt32());
            var plain = new Dictionary<string, byte[]>();
            foreach (var f in m.GetProperty("files").EnumerateArray())
            {
                var name = f.GetProperty("name").GetString()!;
                if (!Sources().ContainsKey(name)) continue;   // chỉ nhận đúng các file đã biết (không cho gói ghi đường dẫn tuỳ ý)
                using var es = z.GetEntry($"files/{name}.enc")!.Open();
                using var ms = new MemoryStream(); es.CopyTo(ms);
                byte[] data;
                try { data = Decrypt(aes, ms.ToArray()); }
                catch (CryptographicException) { return new(false, "Sai khoá khôi phục (hoặc file bị sửa).", info, null, false); }
                if (!string.Equals(Convert.ToHexString(SHA256.HashData(data)), f.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase))
                    return new(false, $"File {name} trong gói bị hỏng (sai sha256).", info, null, false);
                plain[name] = data;
            }
            ScadaConfig? cfg = null;
            if (plain.TryGetValue("config.json", out var cj))
            {
                var tmp = Path.Combine(Path.GetTempPath(), "gwrestore-" + Guid.NewGuid().ToString("N") + ".json");
                try { File.WriteAllBytes(tmp, cj); cfg = ConfigStore.Load(tmp); ConfigMigrations.Run(cfg, tmp); }
                finally { foreach (var x in new[] { tmp, tmp + ".bak-v0" }) { try { File.Delete(x); } catch { } } }
            }
            var other = info.MachineId.Length > 0 && !string.Equals(info.MachineId, _machineId, StringComparison.OrdinalIgnoreCase);
            if (!apply) return new(true, null, info, cfg, other);

            if (LoadKey() != null) { try { Create("pre-restore"); } catch (Exception e) when (e is IOException or InvalidOperationException) { } }   // đường lui nếu khôi phục nhầm
            foreach (var (name, path) in Sources())
            {
                if (!plain.TryGetValue(name, out var data)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
                if (name == "config.json") ConfigStore.Save(path, cfg!);   // mã hoá lại bằng DPAPI của máy này
                else { var t = path + ".tmp"; File.WriteAllBytes(t, data); File.Move(t, path, overwrite: true); }
            }
            return new(true, null, info, cfg, other);
        }
        catch (Exception e) when (e is IOException or InvalidDataException or JsonException or KeyNotFoundException or NullReferenceException)
        {
            return new(false, "Gói sao lưu không hợp lệ: " + e.Message, info, null, false);
        }
    }

    // ------------------------------------------------------------------ mật mã
    static byte[] DeriveKey(string key, byte[] salt, int iterations = Iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(NormalizeKey(key)), salt, iterations, HashAlgorithmName.SHA256, 32);

    /// <summary>nonce(12) ‖ tag(16) ‖ ciphertext.</summary>
    static byte[] Encrypt(byte[] key, byte[] plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var tag = new byte[16]; var ct = new byte[plain.Length];
        using var g = new AesGcm(key, 16);
        g.Encrypt(nonce, plain, ct, tag);
        return nonce.Concat(tag).Concat(ct).ToArray();
    }

    static byte[] Decrypt(byte[] key, byte[] blob)
    {
        if (blob.Length < 28) throw new CryptographicException("blob ngắn");
        var pt = new byte[blob.Length - 28];
        using var g = new AesGcm(key, 16);
        g.Decrypt(blob.AsSpan(0, 12), blob.AsSpan(28), blob.AsSpan(12, 16), pt);
        return pt;
    }
}
