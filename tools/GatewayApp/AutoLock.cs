using System.Text.Json;

namespace GatewayApp;

/// <summary>Tự khoá lại (thu hồi quyền sửa/điều khiển tại máy) sau N phút không thao tác. Cài đặt theo máy, lưu cạnh file cấu hình gateway. 0 = tắt.</summary>
static class AutoLock
{
    public static readonly int[] Choices = { 0, 1, 5, 15, 30, 60 };
    static string PathOf => System.IO.Path.ChangeExtension(MainForm.SettingsPath, ".lock.json");
    static int? _minutes;

    public static int Minutes
    {
        get
        {
            if (_minutes is int m) return m;
            try { _minutes = File.Exists(PathOf) ? JsonSerializer.Deserialize<int>(File.ReadAllText(PathOf)) : 0; }
            catch (Exception e) when (e is IOException or JsonException) { _minutes = 0; }
            return _minutes ??= 0;
        }
        set
        {
            _minutes = Math.Clamp(value, 0, 24 * 60);
            try { File.WriteAllText(PathOf, JsonSerializer.Serialize(_minutes)); } catch (IOException) { /* chỉ mất cài đặt, không ảnh hưởng chạy */ }
        }
    }

    public static string Label(int m) => m == 0 ? "Không tự khoá" : $"{m} phút";

    /// <summary>Ghi nhận lần thao tác cuối (bàn phím/chuột) trên mọi cửa sổ của app.</summary>
    public static DateTime LastInput { get; private set; } = DateTime.UtcNow;
    sealed class Filter : IMessageFilter
    {
        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg is 0x0100 or 0x0201 or 0x0204 or 0x0207 or 0x020A) LastInput = DateTime.UtcNow;   // keydown, nút chuột, cuộn (bỏ WM_MOUSEMOVE: tránh rung chuột giả giữ mở)
            return false;
        }
    }
    static bool _installed;
    public static void Install() { if (_installed) return; _installed = true; Application.AddMessageFilter(new Filter()); }

    public static bool Expired() => Minutes > 0 && DateTime.UtcNow - LastInput >= TimeSpan.FromMinutes(Minutes);
}
