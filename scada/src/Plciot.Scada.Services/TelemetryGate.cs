namespace Plciot.Scada;

/// <summary>
/// Quy tắc gửi telemetry lên cloud (hàm thuần, test được) — ĐƠN GIẢN, không quan tâm dữ liệu có đổi hay không.
/// Trả KHOẢNG CÁCH tối thiểu (ms) kể từ lần gửi trước:
/// <list type="bullet">
/// <item>Vừa có lệnh điều khiển: 0 (gửi ngay, người dùng đang chờ phản hồi).</item>
/// <item>Có người xem webapp: theo TẦN SUẤT GỬI của gói (minMs, vd. 2 giây).</item>
/// <item>Không ai xem: theo TẦN SUẤT LƯU của gói (idleMs, vd. 60 giây) — tốc độ gửi = tốc độ lưu.</item>
/// </list>
/// idleMs &lt;= 0 (server cũ / chưa có gói): luôn theo minMs. Tần suất lưu không bao giờ nhỏ hơn tần suất gửi.
/// </summary>
public static class TelemetryGate
{
    public static double GapMs(bool expedite, bool live, int idleMs, int minMs)
    {
        if (expedite) return 0;
        if (idleMs <= 0 || live) return minMs;
        return Math.Max(idleMs, minMs);
    }
}
