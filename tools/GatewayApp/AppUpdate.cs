using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace GatewayApp;

/// <summary>Thông tin bản mới trên VPS (GET /api/gateway/update).</summary>
sealed record UpdateInfo(string Version, long Size, string Sha256, int ApiLevel)
{
    /// <summary>Bản mới đổi giao thức với server (apiLevel cao hơn bản đang chạy): gateway cũ không còn chạy đúng → cập nhật bắt buộc.</summary>
    public bool Breaking => ApiLevel > AppUpdate.ApiLevel;
}

/// <summary>
/// Cập nhật chính GatewayApp từ VPS. Bản build do máy lập trình tạo (cloud/scripts/publish-gateway.ps1) và đẩy lên cùng sync-vps.
/// Version của bản đang chạy = file <c>version.txt</c> cạnh file chạy (có trong gói cập nhật). Bản dựng tay (không có version.txt) không tự hỏi cập nhật.
/// Cài: tải zip → kiểm sha256 → giải nén ra thư mục tạm → thoát app → script chép đè (giữ server.json của máy) → mở lại với đúng tham số cũ.
/// </summary>
static partial class AppUpdate
{
    /// <summary>Mức tương thích gateway ↔ server mà bản này nói được. TĂNG khi đổi không tương thích ngược với server (xem GATEWAY_API_LEVEL trong cloud/app/src/gatewayUpdate.js). publish-gateway.ps1 đọc số này đưa vào manifest.</summary>
    public const int ApiLevel = 1;

    /// <summary>Phiên bản đã cài mà không chạy nổi (trình cài tự quay về bản cũ và ghi vào đây) → không đề nghị lại đúng bản đó.</summary>
    static string FailedMarker => Path.Combine(DataDir, "update-failed.txt");
    static string? FailedVersion { get { try { return File.Exists(FailedMarker) ? File.ReadAllText(FailedMarker).Trim() : null; } catch { return null; } } }

    public static string? LocalVersion
    {
        get
        {
            try { var f = Path.Combine(AppContext.BaseDirectory, "version.txt"); return File.Exists(f) ? File.ReadAllText(f).Trim() : null; }
            catch { return null; }
        }
    }

    /// <summary>Có bản khác bản đang chạy thì trả thông tin; không có / lỗi mạng / chưa biết version của mình → null.</summary>
    public static async Task<UpdateInfo?> CheckAsync(string server)
    {
        var local = LocalVersion;
        if (string.IsNullOrEmpty(local)) return null;
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(server.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(15) };
            using var res = await http.GetAsync("api/gateway/update");
            if (!res.IsSuccessStatusCode) return null;
            using var d = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var r = d.RootElement;
            var v = r.TryGetProperty("version", out var vv) ? vv.GetString() : null;
            if (string.IsNullOrEmpty(v) || v == local || v == FailedVersion) return null;
            return new UpdateInfo(v, r.TryGetProperty("size", out var s) ? s.GetInt64() : 0, r.TryGetProperty("sha256", out var h) ? h.GetString() ?? "" : "",
                r.TryGetProperty("apiLevel", out var al) && al.TryGetInt32(out var lv) ? lv : 1);
        }
        catch { return null; }
    }

    /// <summary>Tải + kiểm + giải nén. Trả null nếu thành công (đã sẵn sàng cài), ngược lại là thông báo lỗi. <paramref name="progress"/> nhận 0..100.</summary>
    public static async Task<(string? Error, string? Stage)> DownloadAsync(string server, UpdateInfo info, Action<int> progress)
    {
        var root = Path.Combine(Path.GetTempPath(), "GatewayApp-update");
        var zip = Path.Combine(root, $"GatewayApp-{info.Version}.zip");
        var stage = Path.Combine(root, $"stage-{info.Version}");
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
            Directory.CreateDirectory(root);
            using var http = new HttpClient { BaseAddress = new Uri(server.TrimEnd('/') + "/"), Timeout = TimeSpan.FromMinutes(10) };
            using var res = await http.GetAsync("api/gateway/update/download", HttpCompletionOption.ResponseHeadersRead);
            if (!res.IsSuccessStatusCode) return ($"Server trả lỗi {(int)res.StatusCode}", null);
            var total = res.Content.Headers.ContentLength ?? info.Size;
            await using (var src = await res.Content.ReadAsStreamAsync())
            await using (var dst = File.Create(zip))
            {
                var buf = new byte[81920]; long got = 0; int n;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n));
                    got += n;
                    if (total > 0) progress((int)(got * 100 / total));
                }
            }
            if (info.Sha256.Length > 0)
            {
                await using var f = File.OpenRead(zip);
                var h = Convert.ToHexString(await SHA256.HashDataAsync(f)).ToLowerInvariant();
                if (!string.Equals(h, info.Sha256, StringComparison.OrdinalIgnoreCase)) return ("Gói tải về bị hỏng (sai mã sha256), không cài.", null);
            }
            ZipFile.ExtractToDirectory(zip, stage, true);
            if (!File.Exists(Path.Combine(stage, Path.GetFileName(Environment.ProcessPath ?? "GatewayApp.exe")))) return ("Gói cập nhật không có file chạy.", null);
            File.Delete(zip);
            return (null, stage);
        }
        catch (Exception e) { return (e.Message, null); }
    }
}
