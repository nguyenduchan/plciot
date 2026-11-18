using Plciot.Scada;

namespace GatewayApp;

/// <summary>Lịch sử giá trị SQLite (history.db) + gửi bù dữ liệu lên cloud sau khi offline (xem LocalHistoryDb).</summary>
public sealed partial class MainForm
{
    LocalHistoryDb? _hdb;
    CancellationTokenSource? _hdbCts;

    public (long Total, long Unsent, long Oldest) HistoryStats() => _hdb?.Stats() ?? (0, 0, 0);
    public Task<long> ExportHistoryAsync(string path, string format, long fromMs, long toMs) => _hdb == null ? Task.FromResult(0L) : Task.Run(() => _hdb.ExportAsync(path, format, fromMs, toMs, CancellationToken.None));

    /// <summary>true = mẫu này coi như đã tới cloud (đang nối) hoặc không cần đồng bộ (cloud tắt / chưa có user); false = offline → chờ gửi bù.</summary>
    bool CloudSyncedOrNotNeeded() => !(_cfg.CloudEnabled && _cfg.CloudSendData) || _host?.Cloud == CloudState.Connected;

    void StartHistory()
    {
        if (_testMode) return;
        _hdb = new LocalHistoryDb(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(SettingsPath))!, "history.db"), _cfg);
        var cts = _hdbCts = new CancellationTokenSource();
        var db = _hdb;
        Disposed += (_, _) => { cts.Cancel(); db.Flush(); db.Dispose(); };
        _ = Task.Run(async () =>
        {
            var tick = 0;
            while (!cts.IsCancellationRequested)
            {
                try { await Task.Delay(2000, cts.Token); } catch (OperationCanceledException) { return; }
                try
                {
                    db.Flush();
                    var h = _host;
                    if (++tick % 3 == 0 && h != null && _cfg.CloudEnabled && _cfg.CloudSendData && h.Cloud == CloudState.Connected)
                    {
                        var n = await db.BackfillAsync(p => h.SendBackfillAsync(p, cts.Token), () => h.Cloud == CloudState.Connected && ReferenceEquals(_host, h), cts.Token);
                        if (n > 0) _log.Add("INFO", "history", $"đã gửi bù {n} mốc dữ liệu lúc offline lên cloud");
                    }
                }
                catch (OperationCanceledException) { return; }
                catch (Exception e) { _log.Add("WARN", "history", "lịch sử: " + e.Message); }
            }
        });
    }
}
