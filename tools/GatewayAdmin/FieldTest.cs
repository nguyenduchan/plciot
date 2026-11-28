#if DEBUG
using System.Text.Json;
using System.Text.Json.Nodes;
using GatewayApp;

namespace GatewayAdmin;

/// <summary>
/// Kiểm thử GatewayAdmin QUA INTERNET THẬT với board Waveshare (bản Debug): --fieldtest THƯ_MỤC --gw site/device [--child c].
/// GatewayAdmin → server (HTTPS, ký khoá máy) → MQTT rpc → board → trả lời. Đọc TOÀN BỘ cấu hình (như cửa sổ cài đặt), sửa ở cửa sổ cài đặt
/// đầy đủ (PUT /api/config) rồi ở 📱 Cài đặt hiện trường (/api/m/*), kiểm xung đột Rev, chặn ghi thử từ xa, chụp hai cửa sổ.
/// Kết quả: fieldtest-result.txt (FAIL = lỗi), field-window.png, relay-window.png. Trả lại tên/nhãn như cũ khi xong.
/// </summary>
static class FieldTest
{
    public static async Task RunAsync(AdminForm form, string outDir, string gw, string child)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        void Info(string s) => log.Add("INFO " + s);
        try
        {
            await form.ReloadForTestAsync();
            var g = form.Rows.FirstOrDefault(r => $"{r.Site}/{r.Device}" == gw);
            Check($"server liệt kê gateway {gw}", g != null, $"{form.Rows.Count} gateway");
            if (g == null) throw new InvalidOperationException("không có gateway đích");
            Check("chủ trạm đã bật hỗ trợ từ xa trên webapp", g.Allowed, $"loại {g.Kind}, bản {g.Version}");
            var c = new RemoteClient(new RelayHandler(form.Api, g.Site, g.Device), gw);

            // ---------------- 1. thấy TOÀN BỘ thông số (đúng dữ liệu cửa sổ cài đặt đầy đủ)
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var st = await c.StateAsync();
            Check("GET /api/state qua internet", st.Running, $"{sw.ElapsedMilliseconds} ms, rev {st.Rev}");
            var cfg = await c.ConfigAsync();
            var pack = cfg.Config.Pack.Where(p => p.Child == child).ToList();
            Info($"cấu hình: site {cfg.Config.Site}/{cfg.Config.Device}, PollMs {cfg.Config.PollMs}, {cfg.Config.Pack.Count} field, {cfg.Config.Connections.Count} kết nối, {cfg.Devices.Count} thiết bị");
            foreach (var p in pack)
                Info($"  {p.Child}.{p.Field} D{p.Address} {p.DataType} ÷{p.Scale} {p.Access} Params {string.Join(",", p.Params.Select(kv => kv.Key + "=" + kv.Value))} · {cfg.Fields.GetValueOrDefault(p.Child + "." + p.Field)?.Title}");
            foreach (var cn in cfg.Config.Connections) Info($"  kết nối {cn.Protocol} {cn.Host}:{cn.Port} {string.Join(",", cn.Options.Select(kv => kv.Key + "=" + kv.Value))}");
            var run = pack.FirstOrDefault(p => p.Field == "run");
            Check("thấy thiết bị RS485 KTV đã thêm + tuỳ chọn riêng (đọc 2100H, ghi 1/5)", run != null && run.Param("raddr") == "8448" && run.Param("von") == "1" && run.Param("voff") == "5",
                $"{pack.Count} field");
            var model0 = cfg.Devices.GetValueOrDefault(child)?.Model;
            Check("thấy mã mẫu của thiết bị (Devices.Model)", model0 == "invt-gd20", model0 ?? "(null)");

            // ---------------- 2. sửa ở cửa sổ cài đặt đầy đủ (PUT /api/config) — giữ nguyên tuỳ chọn mẫu
            var keyA = child + ".a";
            var oldTitle = cfg.Fields.GetValueOrDefault(keyA)?.Title ?? "";
            cfg.Fields[keyA].Title = "Dòng động cơ (KS sửa)";
            var oldPoll = cfg.Config.PollMs; cfg.Config.PollMs = oldPoll == 1000 ? 2000 : 1000;
            var put = await c.PutConfigAsync(cfg);
            Check("PUT /api/config qua internet (cửa sổ cài đặt đầy đủ)", put.Ok, put.Err ?? "");
            await Task.Delay(3000);
            var cfg2 = await c.ConfigAsync();
            var run2 = cfg2.Config.Pack.FirstOrDefault(p => p.Child == child && p.Field == "run");
            Check("board nhận cấu hình mới (nhãn + chu kỳ đọc)", cfg2.Fields.GetValueOrDefault(keyA)?.Title == "Dòng động cơ (KS sửa)" && cfg2.Config.PollMs == cfg.Config.PollMs,
                $"{cfg2.Fields.GetValueOrDefault(keyA)?.Title} · PollMs {cfg2.Config.PollMs}");
            Check("lưu từ C# KHÔNG làm mất tuỳ chọn mẫu (raddr/von/voff, Model)", run2?.Param("von") == "1" && run2?.Param("voff") == "5" && cfg2.Devices.GetValueOrDefault(child)?.Model == "invt-gd20",
                $"von {run2?.Param("von")} voff {run2?.Param("voff")} model {cfg2.Devices.GetValueOrDefault(child)?.Model}");

            // ---------------- 3. 📱 Cài đặt hiện trường: cùng /api/m/* với điện thoại KTV
            async Task<(int, JsonObject)> M(string method, string path, object? body = null)
            {
                var (code, text) = await form.Api.RpcAsync(g.Site, g.Device, method, path, body == null ? "" : JsonSerializer.Serialize(body));
                return (code, (JsonNode.Parse(string.IsNullOrEmpty(text) ? "{}" : text) as JsonObject) ?? new JsonObject());
            }
            var (s1, ms) = await M("GET", "/api/m/state");
            var dev = ms["Devices"]?.AsArray().Select(x => x!.AsObject()).FirstOrDefault(d => d["Child"]?.ToString() == child);
            Check("GET /api/m/state: thấy cái KTV đang cài (thiết bị, giá trị, KTV, sửa gần nhất)", s1 == 200 && dev != null,
                $"rev {ms["Rev"]}, bật {ms["Enabled"]}, KTV {ms["Techs"]?.ToJsonString()}, sửa gần nhất {ms["LastChange"]?.ToJsonString()}");
            Info("  giá trị: " + string.Join(", ", dev?["Fields"]?.AsArray().Select(f => $"{f!["Label"]}={f["Value"]}{f["Unit"]}") ?? Array.Empty<string>()));
            var rev = ms["Rev"]!.GetValue<int>();
            var oldDevTitle = dev?["Title"]?.ToString() ?? "";
            var (s2, ed) = await M("POST", "/api/m/device", new { Rev = rev, Child = child, Template = "invt-gd20", Unit = 1, Title = oldDevTitle + " (KS sửa từ xa)" });
            Check("sửa thiết bị từ xa (đổi tên, áp mẫu)", s2 == 200 && ed["Ok"]?.GetValue<bool>() == true, ed.ToJsonString());
            var (s3, cf) = await M("POST", "/api/m/device", new { Rev = rev, Child = child, Template = "invt-gd20", Unit = 1, Title = "bản cũ" });
            Check("lưu bằng Rev cũ → 409 rev_conflict (hai nơi sửa cùng lúc)", s3 == 409 && cf["Err"]?.ToString() == "rev_conflict", cf["Msg"]?.ToString() ?? cf.ToJsonString());
            var (s4, pr) = await M("POST", "/api/m/probe", new { Child = child });
            Check("đọc thử từ xa", s4 == 200 && pr["Ok"]?.GetValue<bool>() == true, string.Join(", ", pr["Items"]?.AsArray().Select(i => $"{i!["Field"]}={i["Value"]}") ?? Array.Empty<string>()));
            try
            {
                var (s5, wr) = await M("POST", "/api/m/write", new { Child = child, Field = "run", Value = 1 });
                Check("ghi thử từ xa bị chặn (chỉ tại chỗ)", s5 is 403 or 404, $"HTTP {s5} {wr.ToJsonString()}");
            }
            catch (AdminApiException e) { Check("ghi thử từ xa bị chặn (chỉ tại chỗ)", e.Code == "radmin_route_blocked", e.Code); }

            // ---------------- 4. chụp hai cửa sổ
            var fs = new FieldSetupForm(form.Api, g); fs.Show(form);
            await Task.Delay(7000);
            Snap(fs, Path.Combine(outDir, "field-window.png")); fs.Close();
            var win = await form.OpenAsync(g);
            Check("mở cửa sổ cài đặt đầy đủ qua internet", win != null);
            if (win != null) { await Task.Delay(6000); Snap(win, Path.Combine(outDir, "relay-window.png")); win.Close(); }

            // ---------------- trả lại như cũ
            var (_, ms2) = await M("GET", "/api/m/state");
            await M("POST", "/api/m/device", new { Rev = ms2["Rev"]!.GetValue<int>(), Child = child, Template = "invt-gd20", Unit = 1, Title = oldDevTitle });
            var cfg3 = await c.ConfigAsync(); cfg3.Config.PollMs = oldPoll;
            var back = await c.PutConfigAsync(cfg3);
            Check("trả lại tên + chu kỳ đọc cũ", back.Ok, $"nhãn dòng điện về mẫu: {oldTitle}");
        }
        catch (Exception e) { Check("chạy kiểm thử", false, AdminApi.Explain(e) + " " + RemoteClient.Explain(e) + " " + e.GetType().Name); }
        File.WriteAllLines(Path.Combine(outDir, "fieldtest-result.txt"), log);
    }

    static void Snap(Form f, string path)
    {
        using var bmp = new Bitmap(f.Width, f.Height);
        f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
        bmp.Save(path);
    }
}
#endif
