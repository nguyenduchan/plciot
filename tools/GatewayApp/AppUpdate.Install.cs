using System.Diagnostics;
using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Cài bản mới và QUAY VỀ bản cũ.
/// Bản đang chạy được sao lưu vào <c>ProgramData\PlciotScada\app-prev</c> (bền vững, sống qua nhiều lần khởi động) trước khi chép đè.
/// Quay về bản cũ xảy ra khi: (1) bản mới chết trong 25 giây đầu (script cài), (2) bản mới khởi động 3 lần liền mà chưa "khoẻ" (chưa chạy đủ 90 giây — <see cref="StartupGuard"/>),
/// (3) người dùng bấm "↩ Bản trước" / chạy <c>--rollback</c>.
/// </summary>
static partial class AppUpdate
{
    const int HealthySeconds = 90, MaxUnhealthyStarts = 3;

    static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlciotScada");
    static string PrevDir => Path.Combine(DataDir, "app-prev");
    static string PrevInfoPath => Path.Combine(DataDir, "app-prev.json");
    static string PendingPath => Path.Combine(DataDir, "update-pending.json");
    static string ExeName => Path.GetFileName(Environment.ProcessPath ?? "GatewayApp.exe");

    sealed record PrevInfo(string Version, int ConfigSchema);
    sealed class Pending { public string Version { get; set; } = ""; public int Launches { get; set; } }

    /// <summary>Phiên bản của bản sao lưu (bản trước). Null nếu chưa có hoặc trùng bản đang chạy.</summary>
    public static string? PrevVersion
    {
        get
        {
            try
            {
                var f = Path.Combine(PrevDir, "version.txt");
                if (!File.Exists(f) || !File.Exists(Path.Combine(PrevDir, ExeName))) return null;
                var v = File.ReadAllText(f).Trim();
                return v.Length > 0 && v != LocalVersion ? v : null;
            }
            catch { return null; }
        }
    }

    // ---- khởi động / sức khoẻ
    /// <summary>Gọi lúc mở app. Sau một lần cập nhật mà bản mới khởi động 3 lần liền chưa chạy đủ 90 giây → tự quay về bản trước (trả true: app phải thoát ngay).</summary>
    public static bool StartupGuard()
    {
        try
        {
            if (!File.Exists(PendingPath)) return false;
            var p = JsonSerializer.Deserialize<Pending>(File.ReadAllText(PendingPath));
            if (p == null || p.Version != LocalVersion) { File.Delete(PendingPath); return false; }   // đang chạy bản khác (đã quay về / chép tay): bỏ theo dõi
            p.Launches++;
            if (p.Launches >= MaxUnhealthyStarts && PrevVersion != null) { LaunchRollback(auto: true); return true; }
            File.WriteAllText(PendingPath, JsonSerializer.Serialize(p));
        }
        catch { }
        return false;
    }

    /// <summary>Chạy đủ <see cref="HealthySeconds"/> giây không chết → bản mới coi là khoẻ, thôi theo dõi.</summary>
    public static void MarkHealthyIfDue()
    {
        try
        {
            if (!File.Exists(PendingPath)) return;
            if ((DateTime.Now - Process.GetCurrentProcess().StartTime).TotalSeconds >= HealthySeconds) File.Delete(PendingPath);
        }
        catch { }
    }

    // ---- cài bản mới
    /// <summary>Chạy script cài sau khi app thoát: sao lưu bản cũ → chép đè (giữ server.json) → mở lại → đợi 25 giây; bản mới đã chết thì chép bản cũ về. Gọi xong thì app phải thoát ngay.</summary>
    public static void LaunchInstaller(string stage, string version, bool healthCheck = true)
    {
        Directory.CreateDirectory(DataDir);
        File.WriteAllText(PrevInfoPath, JsonSerializer.Serialize(new PrevInfo(LocalVersion ?? "", ConfigMigrations.Current)));
        File.WriteAllText(PendingPath, JsonSerializer.Serialize(new Pending { Version = version, Launches = 0 }));
        var nl = "\r\n";
        var dir = BaseDir;
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("không rõ file chạy");
        var args = Args();
        var cmd = Path.Combine(Path.GetDirectoryName(stage)!, "install.cmd");
        var health = healthCheck
            ? $"timeout /t 25 /nobreak >nul{nl}" +
              $"tasklist /FI \"IMAGENAME eq {ExeName}\" 2>nul | find /I \"{ExeName}\" >nul && goto ok{nl}" +
              Restore(dir) +
              $"(echo {version})> \"{FailedMarker}\"{nl}" +
              $"del /q \"{PendingPath}\" >nul 2>&1{nl}" +
              $"start \"\" \"{exe}\" {args}{nl}"
            : "";
        File.WriteAllText(cmd,
            "@echo off" + nl + WaitForExit(nl) +
            $"if exist \"{PrevDir}\" rmdir /s /q \"{PrevDir}\"" + nl +
            $"robocopy \"{dir}\" \"{PrevDir}\" /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul" + nl +
            $"robocopy \"{stage}\" \"{dir}\" /E /R:15 /W:1 /NFL /NDL /NJH /NJS /NP /XF server.json >nul" + nl +
            $"start \"\" \"{exe}\" {args}" + nl +
            health +
            ":ok" + nl +
            $"rmdir /s /q \"{stage}\" >nul 2>&1" + nl);
        Run(cmd);
    }

    // ---- quay về bản trước
    /// <summary>Quay về bản trước (người dùng chủ động hoặc tự động khi bản mới lỗi). Bản đang chạy được đánh dấu "lỗi/bỏ qua" để không bị đề nghị lại. Gọi xong thì app phải thoát ngay.</summary>
    public static void LaunchRollback(bool auto)
    {
        if (PrevVersion == null) throw new InvalidOperationException("chưa có bản trước để quay về");
        var nl = "\r\n";
        var dir = BaseDir;
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("không rõ file chạy");
        var root = Path.Combine(Path.GetTempPath(), "GatewayApp-update");
        Directory.CreateDirectory(root);
        var cmd = Path.Combine(root, "rollback.cmd");
        File.WriteAllText(cmd,
            "@echo off" + nl + WaitForExit(nl) +
            Restore(dir) +
            $"(echo {LocalVersion})> \"{FailedMarker}\"{nl}" +   // bản vừa rời đi: không đề nghị lại cho tới khi có bản mới hơn
            $"del /q \"{PendingPath}\" >nul 2>&1{nl}" +
            $"start \"\" \"{exe}\" {Args()}{nl}");
        Run(cmd);
    }

    // ---- phần dùng chung của script
    static string BaseDir => AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    static string Args() => string.Join(" ", Environment.GetCommandLineArgs().Skip(1).Select(a => a.Contains(' ') ? $"\"{a}\"" : a));
    static string WaitForExit(string nl) =>
        $":wait{nl}tasklist /FI \"PID eq {Environment.ProcessId}\" 2>nul | find \"{Environment.ProcessId}\" >nul && (timeout /t 1 /nobreak >nul & goto wait){nl}";

    /// <summary>Chép bản trước về thư mục chạy (giữ server.json). Nếu lúc nâng cấp định dạng cấu hình đã đổi (schema cao hơn bản trước) thì trả lại file cấu hình gốc đã sao lưu.</summary>
    static string Restore(string dir)
    {
        var nl = "\r\n";
        var s = $"robocopy \"{PrevDir}\" \"{dir}\" /E /R:15 /W:1 /NFL /NDL /NJH /NJS /NP /XF server.json >nul{nl}";
        try
        {
            var info = File.Exists(PrevInfoPath) ? JsonSerializer.Deserialize<PrevInfo>(File.ReadAllText(PrevInfoPath)) : null;
            var cfg = MainForm.SettingsPath;
            var bak = info == null ? null : $"{cfg}.bak-v{info.ConfigSchema}";
            if (info != null && info.ConfigSchema < ConfigMigrations.Current && File.Exists(bak))
                s += $"copy /y \"{bak}\" \"{cfg}\" >nul{nl}";
        }
        catch { }
        return s;
    }

    static void Run(string cmd) =>
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"{cmd}\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
}
