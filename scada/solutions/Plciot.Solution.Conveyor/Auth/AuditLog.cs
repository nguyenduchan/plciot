using System.IO;
using System.Text;

namespace Plciot.Solution.Conveyor.Auth;

/// <summary>
/// Nhật ký kiểm toán dạng thêm vào cuối file theo tháng (audit-YYYYMM.log). Chỉ ghi, không sửa/xoá từ ứng dụng.
/// Một dòng = một sự kiện: thời gian | người | sự kiện | chi tiết.
/// </summary>
public sealed class AuditLog
{
    readonly string _dir;
    readonly object _lock = new();
    readonly Func<DateTime> _now;

    public AuditLog(string dir, Func<DateTime>? now = null) { _dir = dir; _now = now ?? (() => DateTime.Now); }

    public void Write(string user, string evt, string detail = "")
    {
        var t = _now();
        var line = $"{t:yyyy-MM-dd HH:mm:ss} | {Clean(user)} | {Clean(evt)} | {Clean(detail)}";
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(_dir);
                File.AppendAllText(Path.Combine(_dir, $"audit-{t:yyyyMM}.log"), line + Environment.NewLine, Encoding.UTF8);
            }
            catch (IOException) { /* ổ đĩa lỗi không được làm sập giao diện điều khiển */ }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>Đọc tối đa <paramref name="max"/> dòng mới nhất (từ tháng hiện tại lùi về trước).</summary>
    public string[] Recent(int max = 300)
    {
        lock (_lock)
        {
            try
            {
                if (!Directory.Exists(_dir)) return Array.Empty<string>();
                var lines = new List<string>();
                foreach (var f in Directory.GetFiles(_dir, "audit-*.log").OrderByDescending(x => x, StringComparer.Ordinal))
                {
                    lines.InsertRange(0, File.ReadAllLines(f, Encoding.UTF8));
                    if (lines.Count >= max) break;
                }
                return lines.Skip(Math.Max(0, lines.Count - max)).ToArray();
            }
            catch (IOException) { return Array.Empty<string>(); }
        }
    }

    // một dòng một sự kiện: không cho nội dung nhập từ người dùng chèn thêm dòng giả
    static string Clean(string s) => (s ?? "").Replace('\r', ' ').Replace('\n', ' ').Replace('|', '/');
}
