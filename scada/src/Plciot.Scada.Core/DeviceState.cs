using System.Text.Json;

namespace Plciot.Scada;

/// <summary>Ảnh chụp trạng thái PLC dựng từ telemetry/status/history đi qua broker nội bộ (đọc cho giao diện).</summary>
public sealed class DeviceState
{
    readonly object _gate = new();
    ushort[] _regs = new ushort[Contract.TelemetryRegs];
    string _status = "offline";
    DateTime? _telemetryAt;
    HistoryBlock? _history;
    string? _lastAck;

    public sealed record HistoryBlock(int[] Counts, int Seconds, int Hours, int RunSeconds, int[] RunMinutes);

    public sealed record Snapshot(
        ushort[] Regs, string Status, DateTime? TelemetryAt, HistoryBlock? History, string? LastAck)
    {
        public bool Fresh => TelemetryAt is { } t && (DateTime.UtcNow - t).TotalSeconds < 10;
        public int Inputs => Regs[0];
        public int Outputs => Regs[1];
        public int Alarms => Regs[2];
        public bool Manual => Regs[3] == 1;
        public int ManualMask => Regs[4];
        public bool RunRequested => Regs[6] == 1;
        public int Target => Regs[7];
        public int Conveyor => Regs[8];   // 0 dừng, 1 chạy, 2 đủ số lượng, 3 E-stop
        public long Count => Regs[14] + Regs[15] * 65536L;
        public long Total => Regs[16] + Regs[17] * 65536L;
        public long RunSeconds => Regs[10] + Regs[11] * 65536L;
        public long PumpStarts => Regs[12] + Regs[13] * 65536L;
        public bool Estop => (Alarms & 1) != 0;
        public bool LevelFault => (Alarms & 2) != 0;
        public string ConveyorText => Conveyor switch { 0 => "Dừng", 1 => "Chạy", 2 => "Đủ số lượng", 3 => "E-stop", _ => "?" };
    }

    // --- cập nhật trực tiếp từ lõi (không qua JSON) ---
    public void SetTelemetry(ushort[] regs)
    {
        var r = new ushort[Contract.TelemetryRegs];
        Array.Copy(regs, r, Math.Min(regs.Length, r.Length));
        lock (_gate) { _regs = r; _telemetryAt = DateTime.UtcNow; }
    }
    public void SetStatus(string status) { lock (_gate) _status = status; }
    public void SetHistory(HistoryBlock h) { lock (_gate) _history = h; }
    public void SetAck(string ack) { lock (_gate) _lastAck = ack; }

    public void Apply(string kind, byte[] payload)
    {
        try
        {
            lock (_gate)
            {
                switch (kind)
                {
                    case "telemetry":
                        using (var d = JsonDocument.Parse(payload))
                        {
                            var r = d.RootElement.GetProperty("r");
                            var regs = new ushort[Contract.TelemetryRegs];
                            var i = 0;
                            foreach (var v in r.EnumerateArray()) { if (i >= regs.Length) break; regs[i++] = (ushort)v.GetInt32(); }
                            _regs = regs;
                            _telemetryAt = DateTime.UtcNow;
                        }
                        break;
                    case "status":
                        _status = System.Text.Encoding.UTF8.GetString(payload).Trim();
                        break;
                    case "history":
                        using (var d = JsonDocument.Parse(payload))
                        {
                            var e = d.RootElement;
                            int[] arr(string n) => e.GetProperty(n).EnumerateArray().Select(x => x.GetInt32()).ToArray();
                            _history = new HistoryBlock(arr("c"), e.GetProperty("s").GetInt32(), e.GetProperty("n").GetInt32(),
                                e.GetProperty("r").GetInt32(), arr("m"));
                        }
                        break;
                    case "ack":
                        _lastAck = System.Text.Encoding.UTF8.GetString(payload);
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            // gói hỏng từ gateway: bỏ qua, không làm sập giao diện
        }
    }

    /// <summary>Ảnh 300 thanh ghi D0–D299 dựng từ telemetry (D0–D39) và lịch sử giờ (D100–D150, D199–D248).</summary>
    public static ushort[] ImageOf(Snapshot s)
    {
        var img = new ushort[Contract.MaxRegister];
        for (var i = 0; i < s.Regs.Length && i < 40; i++) img[i] = s.Regs[i];
        if (s.History is { } h)
        {
            for (var i = 0; i < 49 && i < h.Counts.Length; i++) img[100 + i] = (ushort)h.Counts[i];
            img[149] = (ushort)h.Seconds; img[150] = (ushort)h.Hours; img[199] = (ushort)h.RunSeconds;
            for (var i = 0; i < 49 && i < h.RunMinutes.Length; i++) img[200 + i] = (ushort)h.RunMinutes[i];
        }
        return img;
    }

    public Snapshot Get()
    {
        lock (_gate) return new Snapshot((ushort[])_regs.Clone(), _status, _telemetryAt, _history, _lastAck);
    }
}
