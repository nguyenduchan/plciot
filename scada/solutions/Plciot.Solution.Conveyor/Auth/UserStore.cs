using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Plciot.Solution.Conveyor.Auth;

public sealed class UserRecord
{
    public string Name { get; set; } = "";
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public Role Role { get; set; } = Role.Viewer;
    public bool Disabled { get; set; }
    public int Iterations { get; set; }
    public string Salt { get; set; } = "";
    public string Hash { get; set; } = "";
    public DateTime Created { get; set; } = DateTime.Now;
}

public sealed record LoginResult(bool Ok, UserRecord? User, string? Error);

/// <summary>
/// Tài khoản cục bộ của PC trong nhà máy (offline, không phụ thuộc Internet/Telegram).
/// Mật khẩu băm PBKDF2-SHA256 với muối riêng; sai nhiều lần thì khoá tạm theo tài khoản.
/// </summary>
public sealed class UserStore
{
    public const int Iterations = 210_000;
    public const int MinPasswordLength = 8;
    public const int MaxFailures = 5;
    public static readonly TimeSpan BaseLock = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan MaxLock = TimeSpan.FromMinutes(15);

    readonly string _path;
    readonly Func<DateTime> _now;
    readonly object _lock = new();
    readonly int _iterations;
    List<UserRecord> _users = new();
    readonly Dictionary<string, (int fails, int strikes, DateTime until)> _attempts = new(StringComparer.OrdinalIgnoreCase);

    public UserStore(string path, Func<DateTime>? now = null, int iterations = Iterations)
    {
        _path = path; _now = now ?? (() => DateTime.Now); _iterations = iterations;
        Load();
    }

    /// <summary>true = chưa có tài khoản nào: lần đầu chạy, phải tạo quản trị viên.</summary>
    public bool NeedsSetup { get { lock (_lock) return _users.Count == 0; } }

    public IReadOnlyList<UserRecord> List() { lock (_lock) return _users.Select(Clone).OrderBy(u => u.Name, StringComparer.OrdinalIgnoreCase).ToList(); }

    static UserRecord Clone(UserRecord u) => new()
    {
        Name = u.Name, Role = u.Role, Disabled = u.Disabled, Iterations = u.Iterations, Salt = u.Salt, Hash = u.Hash, Created = u.Created,
    };

    void Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_path)) { _users = new(); return; }
            try { _users = JsonSerializer.Deserialize<List<UserRecord>>(File.ReadAllText(_path)) ?? new(); }
            catch (JsonException) { throw new InvalidDataException($"File tài khoản hỏng: {_path}. Sao lưu rồi xoá để tạo lại."); }
        }
    }

    void Save()
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_users, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, _path, overwrite: true);          // ghi nguyên tử: mất điện giữa chừng không làm hỏng file
    }

    public static string? ValidateName(string name)
    {
        name = (name ?? "").Trim();
        if (name.Length < 3 || name.Length > 32) return "Tên đăng nhập 3–32 ký tự.";
        // chỉ ASCII: bộ gõ tiếng Việt (Telex) biến "tester" thành "tétr", và tên có dấu dễ gây nhầm giữa các ca
        if (!name.All(c => c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '.' or '_' or '-')) return "Tên chỉ gồm chữ không dấu a-z, số và . _ -";
        return null;
    }

    public static string? ValidatePassword(string password, string name = "")
    {
        if ((password ?? "").Length < MinPasswordLength) return $"Mật khẩu tối thiểu {MinPasswordLength} ký tự.";
        if (!string.IsNullOrEmpty(name) && password!.Contains(name, StringComparison.OrdinalIgnoreCase)) return "Mật khẩu không được chứa tên đăng nhập.";
        if (password!.Distinct().Count() < 4) return "Mật khẩu quá đơn giản.";
        return null;
    }

    (string salt, string hash) HashNew(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        return (Convert.ToBase64String(salt), Convert.ToBase64String(Rfc2898DeriveBytes.Pbkdf2(password, salt, _iterations, HashAlgorithmName.SHA256, 32)));
    }

    static bool Matches(UserRecord u, string password)
    {
        var salt = Convert.FromBase64String(u.Salt);
        var expected = Convert.FromBase64String(u.Hash);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, u.Iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    UserRecord? Find(string name) => _users.FirstOrDefault(u => u.Name.Equals((name ?? "").Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>Tạo tài khoản. Trả null nếu thành công, ngược lại là thông báo lỗi.</summary>
    public string? Create(string name, string password, Role role)
    {
        name = (name ?? "").Trim();
        var err = ValidateName(name) ?? ValidatePassword(password, name);
        if (err != null) return err;
        lock (_lock)
        {
            if (Find(name) != null) return "Tên đăng nhập đã tồn tại.";
            var (salt, hash) = HashNew(password);
            _users.Add(new UserRecord { Name = name, Role = role, Iterations = _iterations, Salt = salt, Hash = hash, Created = _now() });
            Save();
        }
        return null;
    }

    public LoginResult Login(string name, string password)
    {
        lock (_lock)
        {
            var now = _now();
            var key = (name ?? "").Trim();
            if (_attempts.TryGetValue(key, out var a) && a.until > now)
                return new(false, null, $"Tài khoản bị khoá tạm, thử lại sau {Math.Ceiling((a.until - now).TotalSeconds)} giây.");

            var u = Find(key);
            // luôn băm một lần dù tài khoản không tồn tại, để thời gian phản hồi không lộ tên nào có thật
            var ok = u != null && !u.Disabled && Matches(u, password ?? "");
            if (u == null) _ = Rfc2898DeriveBytes.Pbkdf2(password ?? "", new byte[16], _iterations, HashAlgorithmName.SHA256, 32);
            if (ok) { _attempts.Remove(key); return new(true, Clone(u!), null); }

            var (fails, strikes, _) = _attempts.TryGetValue(key, out var prev) ? prev : (0, 0, DateTime.MinValue);
            fails++;
            if (fails >= MaxFailures)
            {
                var span = TimeSpan.FromTicks(Math.Min(MaxLock.Ticks, BaseLock.Ticks << Math.Min(strikes, 10)));
                _attempts[key] = (0, strikes + 1, now + span);
                return new(false, null, $"Sai quá {MaxFailures} lần. Khoá {Math.Ceiling(span.TotalSeconds)} giây.");
            }
            _attempts[key] = (fails, strikes, DateTime.MinValue);
            if (u?.Disabled == true) return new(false, null, "Tài khoản đã bị khoá. Liên hệ quản trị viên.");
            return new(false, null, $"Sai tên hoặc mật khẩu ({MaxFailures - fails} lần thử còn lại).");
        }
    }

    int ActiveAdmins(string? except = null) => _users.Count(u => u.Role == Role.Admin && !u.Disabled && !u.Name.Equals(except, StringComparison.OrdinalIgnoreCase));

    public string? SetPassword(string name, string password)
    {
        var err = ValidatePassword(password, name);
        if (err != null) return err;
        lock (_lock)
        {
            var u = Find(name); if (u == null) return "Không có tài khoản này.";
            (u.Salt, u.Hash) = HashNew(password); u.Iterations = _iterations;
            _attempts.Remove(u.Name);
            Save();
        }
        return null;
    }

    public string? SetRole(string name, Role role)
    {
        lock (_lock)
        {
            var u = Find(name); if (u == null) return "Không có tài khoản này.";
            if (u.Role == Role.Admin && role != Role.Admin && ActiveAdmins(u.Name) == 0) return "Phải còn ít nhất một quản trị viên đang hoạt động.";
            u.Role = role; Save();
        }
        return null;
    }

    public string? SetDisabled(string name, bool disabled)
    {
        lock (_lock)
        {
            var u = Find(name); if (u == null) return "Không có tài khoản này.";
            if (disabled && u.Role == Role.Admin && ActiveAdmins(u.Name) == 0) return "Phải còn ít nhất một quản trị viên đang hoạt động.";
            u.Disabled = disabled; Save();
        }
        return null;
    }

    public string? Delete(string name)
    {
        lock (_lock)
        {
            var u = Find(name); if (u == null) return "Không có tài khoản này.";
            if (u.Role == Role.Admin && !u.Disabled && ActiveAdmins(u.Name) == 0) return "Phải còn ít nhất một quản trị viên đang hoạt động.";
            _users.Remove(u); Save();
        }
        return null;
    }
}
