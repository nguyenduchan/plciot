using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Lịch sử giá trị lưu trong SQLite (history.db cạnh file cấu hình), chỉ gateway này dùng.
/// - Mỗi field một mẫu mỗi <see cref="ScadaConfig.LocalHistoryIntervalSec"/> giây (mọi field cùng chu kỳ dùng chung một mốc ts).
/// - Giữ <see cref="ScadaConfig.LocalHistoryDays"/> ngày (0 = không giới hạn).
/// - Mẫu ghi lúc cloud KHÔNG nối được đánh dấu sent=0; khi nối lại <see cref="BackfillAsync"/> gửi bù đúng thời điểm gốc,
///   nhưng không cũ hơn <see cref="ScadaConfig.CloudRetentionDays"/> (thời hạn lưu của gói trên cloud; server cũng tự chặn).
/// Ghi đĩa chạy nền theo lô (không làm chậm đường đọc PLC).
/// </summary>
public sealed class LocalHistoryDb : IDisposable
{
    const long Day = 86_400_000;
    readonly string _path;
    readonly ScadaConfig _cfg;
    readonly ConcurrentQueue<(long Ts, string Child, string Field, double V, bool Sent)> _q = new();
    readonly ConcurrentDictionary<string, long> _lastBucket = new();
    readonly Dictionary<(string, string), long> _sid = new();
    readonly object _gate = new();
    SqliteConnection? _db;
    long _lastPurge;

    public LocalHistoryDb(string path, ScadaConfig cfg) { _path = path; _cfg = cfg; }

    static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Ghi nhận một giá trị (gọi từ luồng đọc PLC; chỉ xếp hàng). <paramref name="cloudOk"/>=false và đang cần đồng bộ → đánh dấu chưa gửi.</summary>
    public void Record(string child, string field, double v, bool cloudOk)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return;
        var step = Math.Max(1, _cfg.LocalHistoryIntervalSec) * 1000L;
        var ts = NowMs();
        ts -= ts % step;   // mọi field cùng chu kỳ chung một mốc → gửi bù thành một bản tin
        var k = child + "\0" + field;
        if (_lastBucket.TryGetValue(k, out var last) && last == ts) return;
        _lastBucket[k] = ts;
        if (_q.Count > 200_000) _q.TryDequeue(out _);   // đĩa lỗi lâu: chặn phình bộ nhớ
        _q.Enqueue((ts, child, field, v, cloudOk));
    }

    SqliteConnection Open()
    {
        if (_db != null) return _db;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
        var c = new SqliteConnection($"Data Source={_path};Pooling=False");
        c.Open();
        Exec(c, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        Exec(c, @"CREATE TABLE IF NOT EXISTS series(id INTEGER PRIMARY KEY, child TEXT NOT NULL, field TEXT NOT NULL, UNIQUE(child, field));
                  CREATE TABLE IF NOT EXISTS samples(ts INTEGER NOT NULL, sid INTEGER NOT NULL, v REAL NOT NULL, sent INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(ts, sid)) WITHOUT ROWID;
                  CREATE INDEX IF NOT EXISTS ix_samples_unsent ON samples(ts) WHERE sent = 0;");
        return _db = c;
    }

    static void Exec(SqliteConnection c, string sql, params (string, object)[] ps)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
        cmd.ExecuteNonQuery();
    }

    long SeriesId(SqliteConnection c, string child, string field)
    {
        if (_sid.TryGetValue((child, field), out var id)) return id;
        Exec(c, "INSERT OR IGNORE INTO series(child, field) VALUES(@c, @f)", ("@c", child), ("@f", field));
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id FROM series WHERE child = @c AND field = @f";
        cmd.Parameters.AddWithValue("@c", child); cmd.Parameters.AddWithValue("@f", field);
        return _sid[(child, field)] = Convert.ToInt64(cmd.ExecuteScalar());
    }

    /// <summary>Ghi các mẫu đang xếp hàng xuống đĩa (một giao dịch) và dọn mẫu quá hạn mỗi giờ. Gọi định kỳ từ luồng nền.</summary>
    public void Flush()
    {
        lock (_gate)
        {
            try
            {
                var c = Open();
                if (!_q.IsEmpty)
                {
                    using var tx = c.BeginTransaction();
                    using var cmd = c.CreateCommand();
                    cmd.Transaction = tx;
                    cmd.CommandText = "INSERT OR REPLACE INTO samples(ts, sid, v, sent) VALUES(@t, @s, @v, @x)";
                    var pt = cmd.Parameters.Add("@t", SqliteType.Integer); var ps = cmd.Parameters.Add("@s", SqliteType.Integer);
                    var pv = cmd.Parameters.Add("@v", SqliteType.Real); var px = cmd.Parameters.Add("@x", SqliteType.Integer);
                    var n = 0;
                    while (n < 20_000 && _q.TryDequeue(out var s))
                    {
                        pt.Value = s.Ts; ps.Value = SeriesId(c, s.Child, s.Field); pv.Value = s.V; px.Value = s.Sent ? 1 : 0;
                        cmd.ExecuteNonQuery(); n++;
                    }
                    tx.Commit();
                }
                var now = NowMs();
                if (now - _lastPurge > 3_600_000)
                {
                    _lastPurge = now;
                    if (_cfg.LocalHistoryDays > 0) Exec(c, "DELETE FROM samples WHERE ts < @c", ("@c", now - _cfg.LocalHistoryDays * Day));
                }
            }
            catch (Exception e) when (e is SqliteException or IOException or UnauthorizedAccessException) { /* đĩa đầy/khoá: thử lại lần sau */ }
        }
    }

    /// <summary>(tổng mẫu, mẫu chưa gửi cloud, mốc cũ nhất ms). Dùng cho hiển thị.</summary>
    public (long Total, long Unsent, long Oldest) Stats()
    {
        lock (_gate)
        {
            try
            {
                var c = Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = "SELECT COUNT(*), COALESCE(SUM(sent = 0), 0), COALESCE(MIN(ts), 0) FROM samples";
                using var r = cmd.ExecuteReader();
                return r.Read() ? (r.GetInt64(0), r.GetInt64(1), r.GetInt64(2)) : (0, 0, 0);
            }
            catch (Exception e) when (e is SqliteException or IOException) { return (0, 0, 0); }
        }
    }

    /// <summary>
    /// Gửi bù các mẫu chưa gửi (sent=0) lên cloud theo thời điểm gốc, cũ nhất trước. Mẫu cũ hơn thời hạn lưu của gói bị bỏ (đánh dấu đã xử lý).
    /// <paramref name="send"/> trả false (mất kết nối) → dừng, mẫu còn lại gửi lần sau. Trả số mốc thời gian đã gửi.
    /// </summary>
    public async Task<int> BackfillAsync(Func<byte[], Task<bool>> send, Func<bool> stillOnline, CancellationToken ct)
    {
        var sent = 0;
        while (!ct.IsCancellationRequested && stillOnline())
        {
            List<(long Ts, string Child, string Field, double V)> rows;
            lock (_gate)
            {
                try
                {
                    var c = Open();
                    var now = NowMs();
                    if (_cfg.CloudRetentionDays > 0)   // quá hạn lưu của gói: cloud sẽ không nhận → không gửi
                        Exec(c, "UPDATE samples SET sent = 1 WHERE sent = 0 AND ts < @c", ("@c", now - _cfg.CloudRetentionDays * Day));
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = @"SELECT s.ts, r.child, r.field, s.v FROM samples s JOIN series r ON r.id = s.sid
                        WHERE s.ts IN (SELECT DISTINCT ts FROM samples WHERE sent = 0 ORDER BY ts LIMIT 40) AND s.sent = 0 ORDER BY s.ts";
                    rows = new();
                    using var rd = cmd.ExecuteReader();
                    while (rd.Read()) rows.Add((rd.GetInt64(0), rd.GetString(1), rd.GetString(2), rd.GetDouble(3)));
                }
                catch (Exception e) when (e is SqliteException or IOException) { return sent; }
            }
            if (rows.Count == 0) return sent;
            foreach (var g in rows.GroupBy(x => x.Ts))
            {
                if (ct.IsCancellationRequested || !stillOnline()) return sent;
                var payload = Build(g.Key, g);
                // gói quá lớn (nhiều field hơn một bản tin chứa được) không gửi được → bỏ qua, không kẹt hàng đợi
                var ok = payload.Length > 4096 || await send(payload);
                if (!ok) return sent;
                lock (_gate) { try { Exec(Open(), "UPDATE samples SET sent = 1 WHERE ts = @t AND sent = 0", ("@t", g.Key)); } catch (Exception e) when (e is SqliteException or IOException) { return sent; } }
                sent++;
                try { await Task.Delay(100, ct); } catch (OperationCanceledException) { return sent; }   // ≈10 bản tin/giây: dưới ngưỡng chống dồn của server
            }
        }
        return sent;
    }
    /// <summary>Các định dạng xuất: (mã, tên hiển thị, đuôi file).</summary>
    public static readonly (string Id, string Label, string Ext)[] ExportFormats =
    {
        ("xlsx", "Excel (.xlsx)", "xlsx"), ("csv", "CSV (.csv)", "csv"), ("tsv", "Văn bản, cột cách nhau bằng Tab (.txt)", "txt"), ("json", "JSON (.json)", "json"),
    };
    const int XlsxMaxRows = 1_048_575;   // giới hạn của một sheet Excel (trừ dòng tiêu đề)

    /// <summary>
    /// Xuất lịch sử trong [fromMs, toMs] (epoch ms) ra file theo <paramref name="format"/> (xlsx | csv | tsv | json), dạng dài:
    /// thời gian · epoch_ms · thiết bị · field · giá trị · trạng thái đồng bộ cloud (sent|pending). Đọc theo trang nên không ngốn RAM. Trả số dòng.
    /// </summary>
    public async Task<long> ExportAsync(string path, string format, long fromMs, long toMs, CancellationToken ct)
    {
        Flush();
        format = format.ToLowerInvariant();
        if (format == "xlsx")
        {
            long total;
            lock (_gate)
            {
                using var cmd = Open().CreateCommand();
                cmd.CommandText = "SELECT COUNT(*) FROM samples WHERE ts > @a AND ts <= @b";
                cmd.Parameters.AddWithValue("@a", fromMs - 1); cmd.Parameters.AddWithValue("@b", toMs);
                total = Convert.ToInt64(cmd.ExecuteScalar());
            }
            if (total > XlsxMaxRows) throw new InvalidOperationException($"Có {total:N0} dòng, vượt giới hạn {XlsxMaxRows:N0} của Excel — chọn khoảng ngày ngắn hơn hoặc xuất CSV.");
        }
        using IExportSink sink = format switch
        {
            "xlsx" => new XlsxSink(path),
            "csv" => new TextSink(path, ',', true),
            "tsv" => new TextSink(path, '\t', false),
            "json" => new JsonSink(path),
            _ => throw new ArgumentException("định dạng không hỗ trợ: " + format),
        };
        long n = 0, cursor = fromMs - 1;
        while (!ct.IsCancellationRequested)
        {
            var page = new List<(long Ts, string Child, string Field, double V, bool Sent)>();
            lock (_gate)
            {
                using var cmd = Open().CreateCommand();
                cmd.CommandText = @"SELECT s.ts, r.child, r.field, s.v, s.sent FROM samples s JOIN series r ON r.id = s.sid
                    WHERE s.ts > @a AND s.ts <= @b ORDER BY s.ts, s.sid LIMIT 5000";
                cmd.Parameters.AddWithValue("@a", cursor); cmd.Parameters.AddWithValue("@b", toMs);
                using var rd = cmd.ExecuteReader();
                while (rd.Read()) page.Add((rd.GetInt64(0), rd.GetString(1), rd.GetString(2), rd.GetDouble(3), rd.GetInt64(4) == 1));
            }
            if (page.Count == 0) break;
            var full = page.Count == 5000;
            if (full) { var cut = page[^1].Ts; page.RemoveAll(x => x.Ts == cut); if (page.Count == 0) break; }   // trang đầy: bỏ ts cuối (có thể cắt dở), trang sau đọc lại từ đó
            foreach (var x in page) { sink.Row(x.Ts, x.Child, x.Field, x.V, x.Sent); n++; }
            if (!full) break;
            cursor = page[^1].Ts;
            await Task.Yield();
        }
        sink.Finish();
        return n;
    }

    interface IExportSink : IDisposable { void Row(long ts, string child, string field, double v, bool sent); void Finish(); }

    /// <summary>CSV / TSV (UTF-8 có BOM để Excel đọc đúng tiếng Việt).</summary>
    sealed class TextSink : IExportSink
    {
        readonly StreamWriter _w; readonly char _sep; readonly bool _quote;
        public TextSink(string path, char sep, bool quote)
        {
            _sep = sep; _quote = quote;
            _w = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read), new System.Text.UTF8Encoding(true)) { NewLine = "\r\n" };
            _w.WriteLine(string.Join(sep, "time_local", "epoch_ms", "device", "field", "value", "cloud"));
        }
        string Esc(string s) => _quote ? (s.IndexOfAny(new[] { ',', '"', '\n', '\r' }) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s) : s.Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ');
        public void Row(long ts, string child, string field, double v, bool sent) =>
            _w.WriteLine(string.Join(_sep, DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"), ts, Esc(child), Esc(field), v.ToString("R", CultureInfo.InvariantCulture), sent ? "sent" : "pending"));
        public void Finish() => _w.Flush();
        public void Dispose() => _w.Dispose();
    }

    /// <summary>JSON: {"rows":[{"t":ms,"time":"…","device":…,"field":…,"value":số,"cloud":"sent|pending"},…]}.</summary>
    sealed class JsonSink : IExportSink
    {
        readonly FileStream _fs; readonly Utf8JsonWriter _w;
        public JsonSink(string path)
        {
            _fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
            _w = new Utf8JsonWriter(_fs, new JsonWriterOptions { Indented = false });
            _w.WriteStartObject(); _w.WriteStartArray("rows");
        }
        public void Row(long ts, string child, string field, double v, bool sent)
        {
            _w.WriteStartObject();
            _w.WriteNumber("t", ts); _w.WriteString("time", DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"));
            _w.WriteString("device", child); _w.WriteString("field", field); _w.WriteNumber("value", v); _w.WriteString("cloud", sent ? "sent" : "pending");
            _w.WriteEndObject();
        }
        public void Finish() { _w.WriteEndArray(); _w.WriteEndObject(); _w.Flush(); }
        public void Dispose() { _w.Dispose(); _fs.Dispose(); }
    }

    /// <summary>Excel .xlsx tối giản (một sheet, cột thời gian là kiểu ngày giờ thật, giá trị là số) — tự ghi OOXML, không cần thư viện ngoài.</summary>
    sealed class XlsxSink : IExportSink
    {
        readonly System.IO.Compression.ZipArchive _zip; readonly StreamWriter _sheet; readonly FileStream _fs;
        int _row = 1;
        public XlsxSink(string path)
        {
            _fs = new FileStream(path, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
            _zip = new System.IO.Compression.ZipArchive(_fs, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true);
            Put("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>");
            Put("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
            Put("xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Lich su\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
            Put("xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>");
            // style 0 = mặc định, style 1 = ngày giờ yyyy-mm-dd hh:mm:ss (numFmt 164)
            Put("xl/styles.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy\\-mm\\-dd\\ hh:mm:ss\"/></numFmts><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>");
            _sheet = new StreamWriter(_zip.CreateEntry("xl/worksheets/sheet1.xml", System.IO.Compression.CompressionLevel.Fastest).Open(), new System.Text.UTF8Encoding(false));
            _sheet.Write("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cols><col min=\"1\" max=\"1\" width=\"20\" customWidth=\"1\"/><col min=\"2\" max=\"4\" width=\"18\" customWidth=\"1\"/><col min=\"5\" max=\"6\" width=\"12\" customWidth=\"1\"/></cols><sheetData>");
            _sheet.Write("<row r=\"1\">" + string.Concat(new[] { "time_local", "epoch_ms", "device", "field", "value", "cloud" }.Select((h, i) => Str(i, 1, h))) + "</row>");
        }
        void Put(string name, string xml) { using var w = new StreamWriter(_zip.CreateEntry(name).Open(), new System.Text.UTF8Encoding(false)); w.Write(xml); }
        static string Col(int i) => ((char)('A' + i)).ToString();
        static string X(string s) => System.Security.SecurityElement.Escape(s) ?? "";
        static string Str(int col, int row, string s) => $"<c r=\"{Col(col)}{row}\" t=\"inlineStr\"><is><t>{X(s)}</t></is></c>";
        public void Row(long ts, string child, string field, double v, bool sent)
        {
            _row++;
            // Excel serial: ngày kể từ 1899-12-30; dùng giờ địa phương để khớp cột time của CSV
            var local = DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime;
            var serial = (local - new DateTime(1899, 12, 30)).TotalDays;
            var inv = CultureInfo.InvariantCulture;
            _sheet.Write($"<row r=\"{_row}\"><c r=\"A{_row}\" s=\"1\"><v>{serial.ToString("R", inv)}</v></c><c r=\"B{_row}\"><v>{ts}</v></c>{Str(2, _row, child)}{Str(3, _row, field)}<c r=\"E{_row}\"><v>{v.ToString("R", inv)}</v></c>{Str(5, _row, sent ? "sent" : "pending")}</row>");
        }
        public void Finish() { _sheet.Write("</sheetData></worksheet>"); _sheet.Flush(); }
        public void Dispose() { _sheet.Dispose(); _zip.Dispose(); _fs.Dispose(); }
    }

    /// <summary>{"schema":2,"bf":1,"ts":ms,"d":{child:{field:số}}} — cùng dạng telemetry thường, thêm cờ bù và thời điểm gốc.</summary>
    static byte[] Build(long ts, IEnumerable<(long Ts, string Child, string Field, double V)> g)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("schema", 2); w.WriteNumber("bf", 1); w.WriteNumber("ts", ts);
            w.WriteStartObject("d");
            foreach (var c in g.GroupBy(x => x.Child))
            {
                w.WriteStartObject(c.Key);
                foreach (var f in c) w.WriteNumber(f.Field, Math.Round(f.V, 6));
                w.WriteEndObject();
            }
            w.WriteEndObject(); w.WriteEndObject();
        }
        return ms.ToArray();
    }

    public void Dispose()
    {
        lock (_gate) { try { _db?.Dispose(); } catch { /* bỏ qua */ } _db = null; }
    }
}
