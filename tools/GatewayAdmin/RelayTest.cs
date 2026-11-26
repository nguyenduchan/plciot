#if DEBUG
using System.Diagnostics;
using GatewayApp;

namespace GatewayAdmin;

/// <summary>
/// Kiểm thử cài đặt từ xa qua INTERNET THẬT (bản Debug): GatewayAdmin → server (HTTPS) → MQTT → gateway → trả lời.
/// Không đi qua localhost/LAN API: gateway đích chỉ cần nối cloud. Kết quả: relaytest-result.txt (FAIL = lỗi), relay-window.png.
/// </summary>
static class RelayTest
{
    public static async Task RunAsync(AdminForm form, string outDir, string gw)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        try
        {
            await form.ReloadForTestAsync();
            var g = form.Rows.FirstOrDefault(r => $"{r.Site}/{r.Device}" == gw);
            Check($"server liệt kê gateway {gw}", g != null, $"{form.Rows.Count} gateway");
            if (g == null) throw new InvalidOperationException("không có gateway đích");
            Check("chủ gateway đã cho phép hỗ trợ từ xa", g.Allowed);
            var c = new RemoteClient(new RelayHandler(form.Api, g.Site, g.Device), gw);

            var sw = Stopwatch.StartNew();
            var st = await c.StateAsync();
            var first = sw.ElapsedMilliseconds;
            var times = new List<long>();
            for (var k = 0; k < 5; k++) { sw.Restart(); await c.StateAsync(); times.Add(sw.ElapsedMilliseconds); }
            Check("GET /api/state qua cloud: gateway đang chạy", st.Running, $"lần đầu {first} ms, trung bình {times.Average():F0} ms (5 lần)");

            var cfg = await c.ConfigAsync();
            Check("GET /api/config qua cloud", cfg.Config != null && cfg.Config.Site == g.Site, $"{cfg.Config?.Pack.Count} field, site {cfg.Config?.Site}");
            var oldPoll = cfg.Config!.PollMs; var oldHost = cfg.Config.CloudHost; var rev0 = st.Rev;
            cfg.Config.PollMs = oldPoll + 7;
            cfg.Config.CloudHost = "khong-duoc-doi.example";   // đường từ xa phải GIỮ thông số cloud
            var put = await c.PutConfigAsync(cfg);
            Check("PUT /api/config qua cloud → gateway nhận, trả lời trước khi khởi động lại", put.Ok, put.Err ?? "");
            ApiState? after = null;
            sw.Restart();
            while (sw.Elapsed < TimeSpan.FromSeconds(60))
            {
                await Task.Delay(2000);
                try { after = await c.StateAsync(); if (after.Rev != rev0 && after.Running) break; } catch (RemoteException) { /* đang khởi động lại, mất cloud vài giây */ }
            }
            Check("gateway khởi động lại với cấu hình mới và NỐI LẠI cloud", after != null && after.Rev != rev0 && after.Running, $"sau {sw.Elapsed.TotalSeconds:F0} s, rev {rev0} → {after?.Rev}");
            var cfg2 = await c.ConfigAsync();
            Check("cấu hình mới có hiệu lực (PollMs đổi)", cfg2.Config.PollMs == oldPoll + 7, $"{cfg2.Config.PollMs}");
            Check("thông số cloud KHÔNG bị đổi qua đường từ xa", cfg2.Config.CloudHost == oldHost, cfg2.Config.CloudHost);
            cfg2.Config.PollMs = oldPoll;
            var back = await c.PutConfigAsync(cfg2);
            Check("trả lại cấu hình cũ", back.Ok);
            await Task.Delay(8000);

            try { await c.RunAsync(false); Check("dừng gateway từ xa bị chặn", false, "server cho phép!"); }
            catch (RemoteException e) { Check("dừng gateway từ xa bị chặn (radmin_route_blocked)", e.Code == "radmin_route_blocked", e.Code); }

            var win = await form.OpenAsync(g);
            Check("mở cửa sổ thiết lập qua cloud (cùng các trang như LAN)", win != null);
            if (win != null)
            {
                await Task.Delay(6000);
                using var bmp = new Bitmap(win.Width, win.Height);
                win.DrawToBitmap(bmp, new Rectangle(0, 0, win.Width, win.Height));
                bmp.Save(Path.Combine(outDir, "relay-window.png"));
                win.Close();
            }
        }
        catch (Exception e) { Check("chạy kiểm thử", false, AdminApi.Explain(e) + " " + RemoteClient.Explain(e) + " " + e.GetType().Name); }
        File.WriteAllLines(Path.Combine(outDir, "relaytest-result.txt"), log);
    }
}
#endif
