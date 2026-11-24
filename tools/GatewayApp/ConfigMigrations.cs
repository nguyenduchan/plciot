using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Nâng cấu hình cục bộ (ProgramData\PlciotScada\gateway-app\config.json) của bản cũ lên định dạng của bản đang chạy, để bản mới không chạy sai trên cấu hình cũ.
/// Thêm một bước: tăng <see cref="Current"/> và thêm lambda vào <see cref="Steps"/> (Steps[i] nâng từ schema i lên i+1).
/// Trước khi đổi gì, file gốc được sao lưu cạnh nó (config.json.bak-v&lt;schema cũ&gt;) để quay lại được.
/// </summary>
static class ConfigMigrations
{
    public const int Current = 2;

    /// <summary>Steps[i]: nâng cấu hình từ schema i lên i+1. Schema 0 → 1: chỉ đánh dấu (chưa có thay đổi định dạng).</summary>
    static readonly Action<ScadaConfig>[] Steps =
    {
        _ => { },
        // 1 → 2: gỡ giao thức S7 / EtherNet/IP / Mitsubishi MC / Omron FINS / Beckhoff ADS / OPC UA — bỏ kết nối + field dùng chúng (chỉ còn Modbus TCP/RTU)
        cfg =>
        {
            cfg.Connections.RemoveAll(c => c.Protocol is not (PlcSource.ModbusTcp or PlcSource.ModbusRtu));
            cfg.Pack.RemoveAll(p => p.Protocol.Length > 0 && p.Source is not (PlcSource.ModbusTcp or PlcSource.ModbusRtu));
        },
    };

    /// <summary>Nâng <paramref name="cfg"/> (đã đọc từ <paramref name="path"/>) lên schema hiện tại. Trả true nếu có thay đổi (cần lưu lại).</summary>
    public static bool Run(ScadaConfig cfg, string path)
    {
        if (cfg.ConfigSchema >= Current) return false;
        var from = cfg.ConfigSchema;
        BackupFile(path, $"bak-v{from}");
        for (var i = from; i < Current; i++) Steps[i](cfg);
        cfg.ConfigSchema = Current;
        return true;
    }

    /// <summary>File cấu hình hỏng/không đọc được: giữ lại bản gốc trước khi app dùng mặc định rồi ghi đè.</summary>
    public static void BackupUnreadable(string path) => BackupFile(path, "bad");

    static void BackupFile(string path, string tag)
    {
        try
        {
            if (!File.Exists(path)) return;
            var dst = $"{path}.{tag}";
            if (!File.Exists(dst)) File.Copy(path, dst);   // giữ bản sao ĐẦU TIÊN (gốc của lần nâng cấp đó), không đè bằng bản đã sửa
        }
        catch (IOException) { }
    }
}
