using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// CHƯƠNG TRÌNH LOGIC của gateway PC (Plciot.Scada.Core/GatewayLogic.cs, docs/GATEWAY-LOGIC.md): một chương trình / gateway,
/// lưu cạnh cấu hình (<c>&lt;config.json&gt;.logic.json</c>), nạp vào lõi mỗi lần gateway chạy. Cùng API với board Waveshare:
///   GET  /api/offline            chương trình + trạng thái chạy
///   PUT  /api/offline {Rev,TzMin,Do}  thay trọn gói (Rev khác → 409 rev_conflict). Từ xa: CHỈ khi server gắn mã duyệt của chủ trạm (appr).
///   POST /api/offline/test {Sec} thử mất mạng — chỉ tại chỗ.
/// </summary>
public sealed partial class MainForm
{
    static string LogicPath => SettingsPath + ".logic.json";

    static LogicProgram ReadLogicFile()
    {
        try { return File.Exists(LogicPath) ? JsonSerializer.Deserialize<LogicProgram>(File.ReadAllText(LogicPath), GatewayLogic.Json) ?? new() : new(); }
        catch (Exception e) when (e is IOException or JsonException) { return new(); }
    }

    /// <summary>Gọi trước host.StartAsync (bản tin config đầu tiên đã mang chương trình).</summary>
    void LoadLogicInto(ScadaHost h)
    {
        var p = ReadLogicFile();
        if (p.Do.Count == 0) { h.Core.Logic.Load(p); return; }
        var err = h.Core.Logic.Validate(p);
        if (err != null) { _log.Add("WARN", "logic", "Chương trình logic không khớp cấu hình hiện tại, KHÔNG chạy: " + err); return; }
        h.Core.Logic.Load(p);
        _log.Add("INFO", "logic", $"Chương trình logic rev {p.Rev}: {p.Do.Count} đầu ra");
    }

    (int, string) LogicGet()
    {
        var p = _host?.Core.Logic.Program ?? ReadLogicFile();
        return (200, Json(new
        {
            Ok = true, p.Rev, Sha = _host?.Core.Logic.Sha ?? GatewayLogic.ShaOf(p), p.TzMin, p.Do,
            Status = _host?.Core.Logic.Status(),
        }));
    }

    (int, string) LogicPut(string body, string via)
    {
        LogicProgram? inc;
        uint? rev;
        try
        {
            using var doc = JsonDocument.Parse(body);
            rev = doc.RootElement.TryGetProperty("Rev", out var r) && r.TryGetUInt32(out var rv) ? rv : null;
            inc = JsonSerializer.Deserialize<LogicProgram>(body, GatewayLogic.Json);
        }
        catch (JsonException) { return Err("bad_json"); }
        if (inc == null) return Err("bad_request");
        var cur = ReadLogicFile();
        if (rev is { } want && want != cur.Rev) return Err("rev_conflict", 409);   // người khác vừa sửa: tải lại rồi sửa tiếp
        var err = (_host?.Core.Logic ?? new GatewayLogic(_cfg)).Validate(inc);
        if (err != null) return Err(err);
        inc.Rev = cur.Rev + 1;
        var tmp = LogicPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(inc, GatewayLogic.Json));
        File.Move(tmp, LogicPath, overwrite: true);   // ghi đè nguyên tử: không bao giờ còn file dở
        var sha = GatewayLogic.ShaOf(inc);
        var text = $"Chương trình logic đổi → rev {inc.Rev} ({via}, {sha[..8]})";
        _log.Add("INFO", "logic", text);
        if (_host is { } h) { h.Core.Logic.Load(inc); h.LogicChanged(text); }
        return (200, Json(new { Ok = true, inc.Rev, Running }));
    }

    LogicPage _logicPage = null!;
    internal void LogicLog(string t) => _log.Add("INFO", "logic", t);
    internal uint LogicRev => _host?.Core.Logic.Rev ?? ReadLogicFile().Rev;

    (string Site, string Device) CloudSiteDevice()
    {
        var sd = Plciot.Scada.Services.Ui.GatewayIdentity.SiteDeviceOfQr(_cfg.GatewayQr);
        return (sd?.Site ?? _cfg.Site, sd?.Device ?? _cfg.Device);
    }

    /// <summary>Đề xuất đang chờ + bảng bản đang chạy (server, ký bằng khoá gateway).</summary>
    internal async Task<JsonElement> LogicPendingAsync()
    {
        if (string.IsNullOrEmpty(_cfg.MqttId)) throw new InvalidOperationException("gateway chưa đăng ký cloud");
        using var http = new HttpClient { BaseAddress = new Uri(CloudPage.ServerOf(_cfg).Trim()), Timeout = TimeSpan.FromSeconds(15) };
        var (site, device) = CloudSiteDevice();
        return await new Plciot.Scada.Services.Ui.GatewayEnrollClient(http).LogicPendingAsync(site, device, Identity());
    }

    /// <summary>
    /// Chủ trạm DUYỆT / TỪ CHỐI tại gateway. Duyệt: mở khoá (mật khẩu gateway / đăng nhập webapp) → áp dụng chương trình server gửi kèm
    /// (đúng bảng vừa xem) → báo server. null = xong, còn lại câu báo lỗi.
    /// </summary>
    internal async Task<string?> DecideLogicAsync(JsonElement pending, bool approve)
    {
        if (!await EnsureUnlockedAsync(approve ? "Xác nhận để duyệt logic mới cho gateway" : "Xác nhận để từ chối đề xuất logic")) return "Chưa mở khoá gateway — không thay đổi gì.";
        var id = pending.GetProperty("id").GetInt64();
        var who = _login?.User is { Length: > 0 } u ? u : "mật khẩu gateway";
        uint rev = 0;
        if (approve)
        {
            var prog = pending.GetProperty("program");
            var body = JsonSerializer.Serialize(new { Rev = ReadLogicFile().Rev, TzMin = prog.GetProperty("TzMin").GetInt32(), Do = prog.GetProperty("Do") });
            var (st, json) = LogicPut(body, $"tại chỗ, chủ trạm duyệt #{id} ({who})");
            LogicLog($"áp dụng đề xuất #{id} tại gateway → {st} {json}");
            if (st != 200) { using var d = JsonDocument.Parse(json); return "Gateway không áp dụng được: " + (d.RootElement.TryGetProperty("Err", out var e) ? e.GetString() : json); }
            rev = LogicRev;
        }
        try
        {
            using var http = new HttpClient { BaseAddress = new Uri(CloudPage.ServerOf(_cfg).Trim()), Timeout = TimeSpan.FromSeconds(15) };
            var (site, device) = CloudSiteDevice();
            await new Plciot.Scada.Services.Ui.GatewayEnrollClient(http).LogicDecideAsync(site, device, Identity(), id, approve ? "approve" : "reject", who, rev);
        }
        catch (Exception e)
        {
            _log.Add("WARN", "logic", $"Đã {(approve ? "áp dụng" : "từ chối")} tại gateway nhưng chưa báo được server: {e.Message}");
            return approve ? "Đã áp dụng trên gateway, nhưng chưa báo được server (" + e.Message + ") — webapp sẽ thấy bản mới khi gateway nối lại." : "Chưa báo được server: " + e.Message;
        }
        return null;
    }

    (int, string) LogicTest(string body)
    {
        using var doc = JsonDocument.Parse(body);
        var sec = doc.RootElement.TryGetProperty("Sec", out var s) && s.TryGetInt32(out var v) ? v : -1;
        if (sec is < 0 or > 3600) return Err("bad_request");
        if (_host == null) return Err("not_running");
        _host.Core.Logic.Test(sec);
        _log.Add("INFO", "logic", sec == 0 ? "Dừng thử mất mạng" : $"THỬ MẤT MẠNG {sec} giây");
        return Ok(Running);
    }
}
