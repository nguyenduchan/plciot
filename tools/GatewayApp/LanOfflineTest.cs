using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử logic KHI MẤT MẠNG trên board giả lập (--offlinetest THƯ_MỤC --lan-target IP:CỔNG --io-data THƯ_MỤC_SIMDATA), bản Debug:
/// gw-sim chạy với cùng SIM_DATA (DI đọc từ di.txt, DO ghi do.txt). Cài HOÀN TOÀN bằng trang "Khi mất mạng" của cửa sổ thiết lập board:
/// đặt 6 chân bằng các ô của trang → Lưu → "Thử mất mạng" → đối chiếu do.txt; đổi DI; thao tác tay (logic nhường); dừng thử (DO giữ nguyên);
/// lưu với Rev cũ → rev_conflict; cài đặt sai → câu báo lỗi. Kết quả: offlinetest-result.txt (FAIL = lỗi).
/// </summary>
public sealed partial class MainForm
{
    public async Task OfflineTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var data = ArgValue(args, "--io-data");
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 8443;
        RemoteForm? rf = null;
        try
        {
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
            if (File.Exists(TrustedBoards.FilePath)) File.Delete(TrustedBoards.FilePath);
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var first = await c.ConfigAsync();
            rf = RemoteForm.ForTest(c, new ApiHello { Kind = "mcu", Port = port, Tls = true }, host, port, first);
            rf.Show(this); await Task.Delay(800);
            foreach (var ch in rf.Config.Pack.Select(p => p.Child).Distinct().ToList()) DeviceDialog.Remove(rf, ch);

            // thiết bị trên board: run ← DO1 (D20), flow ← DI1 (D10) — flow là giá trị cho mẫu "ngưỡng"
            static Action<DataGridView> Keep(params (string name, string addr)[] f) => g =>
            {
                for (var k = g.Rows.Count - 1; k >= 0; k--)
                    if (!g.Rows[k].IsNewRow && !f.Any(x => x.name == Convert.ToString(g.Rows[k].Cells[0].Value))) g.Rows.RemoveAt(k);
                foreach (DataGridViewRow r in g.Rows)
                    if (f.FirstOrDefault(x => x.name == Convert.ToString(r.Cells[0].Value)) is { name: not null } x) { r.Cells[5].Value = x.addr; r.Cells[6].Value = "1"; }
            };
            var e1 = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusRtu, "RS485", 9600, new() { ["parity"] = "Even", ["difilter"] = "0" }, new() { ["unit"] = "0" }, Keep(("run", "20"), ("flow", "10")));
            Check("thêm thiết bị DI/DO board bằng hộp thoại", e1.Length == 0, e1);
            await rf.ApplyAsync("offlinetest: thiết bị");
            var dev = rf.Config.Pack.First().Child;
            var diFile = Path.Combine(data, "di.txt"); var doFile = Path.Combine(data, "do.txt");
            int Do() { try { return int.Parse(File.ReadAllText(doFile).Trim()); } catch (Exception) { return -1; } }
            async Task<bool> WaitDo(Func<int, bool> ok, int sec = 6) { for (var k = 0; k < sec * 4; k++) { if (ok(Do())) return true; await Task.Delay(250); } return false; }
            File.WriteAllText(diFile, "0x02");   // DI1 = 0 (flow 0 → ngưỡng: bật), DI2 = 1 (DO1 theo DI2: bật)

            var page = rf.OfflinePageForTest!;
            rf.ShowOffline(); await Task.Delay(1500);
            Check("trang 'Khi mất mạng' đọc được board", page.StatusText.Length > 0 && !page.StatusText.StartsWith("Không đọc"), page.StatusText);
            var now = DateTime.UtcNow.AddHours(7);
            // cài sai trước: lịch có giờ bật = giờ tắt → trang chặn, không gửi
            var bad = await page.SetForTestAsync(row => { var r = row(5); r.Mode.SelectedIndex = OfflinePage.ModeIndex("schedule"); r.From.Text = "08:00"; r.To.Text = "08:00"; });
            Check("lịch giờ bật = giờ tắt → báo lỗi, không lưu", bad != null && bad.Contains("khác nhau"), bad ?? "");
            var err = await page.SetForTestAsync(row =>
            {
                var r1 = row(1); r1.Mode.SelectedIndex = OfflinePage.ModeIndex("follow"); r1.Di.SelectedIndex = 1; r1.Delay.Value = 0;
                var r2 = row(2); r2.Mode.SelectedIndex = OfflinePage.ModeIndex("threshold"); r2.Delay.Value = 0;
                r2.Field.SelectedIndex = Math.Max(0, Enumerable.Range(0, r2.Field.Items.Count).FirstOrDefault(k => Convert.ToString(r2.Field.Items[k])!.Contains("flow") || Convert.ToString(r2.Field.Items[k])!.Contains("Lưu lượng")));
                r2.On.Value = 0; r2.Off.Value = 1;
                var r3 = row(3); r3.Mode.SelectedIndex = OfflinePage.ModeIndex("cycle"); r3.Delay.Value = 0; r3.OnMin.Value = 0.1m; r3.OffMin.Value = 0.1m;
                var r4 = row(4); r4.Mode.SelectedIndex = OfflinePage.ModeIndex("on"); r4.Delay.Value = 0;
                var r5 = row(5); r5.Mode.SelectedIndex = OfflinePage.ModeIndex("schedule"); r5.Delay.Value = 0;
                r5.From.Text = now.AddMinutes(-30).ToString("HH:mm"); r5.To.Text = now.AddMinutes(30).ToString("HH:mm");
                var r6 = row(6); r6.Mode.SelectedIndex = OfflinePage.ModeIndex("off"); r6.Delay.Value = 0;
            });
            Check("lưu 6 chính sách xuống board bằng các ô của trang", err == null, err ?? "");
            var saved = await c.OfflineAsync();
            Check("board lưu đủ 8 chân (6 có logic + 2 giữ nguyên)", saved.Do.Count == 8 && saved.Do.Count(x => x.Mode != "hold") == 6, string.Join(",", saved.Do.Select(x => x.Mode)));
            Check("đọc lại đúng tham số (lịch, ngưỡng, chu kỳ)",
                saved.Do.First(x => x.Ch == 5).From?.Length == 5 && saved.Do.First(x => x.Ch == 2).Field == $"{dev}.flow" && saved.Do.First(x => x.Ch == 3).OnSec == 6,
                $"from={saved.Do.First(x => x.Ch == 5).From} field={saved.Do.First(x => x.Ch == 2).Field} on={saved.Do.First(x => x.Ch == 3).OnSec}");
            Check("chưa nối cloud → không 'mất mạng', DO chưa đổi", saved.Status is { Down: false, Expected: false } && Do() is 0 or -1, $"do={Do()}");

            await page.TestForTestAsync(60);
            // DO1 (DI2=1) + DO2 (flow 0 ≤ 0) + DO3 (chu kỳ bắt đầu BẬT) + DO4 (bật) + DO5 (trong khung giờ) = 0x1F; DO6 tắt
            Check("thử mất mạng → DO = 0x1F (theo DI, ngưỡng, chu kỳ, bật, lịch; DO6 tắt)", await WaitDo(d => d == 0x1F), $"do=0x{Do():X2}");
            await page.RefreshForTestAsync();
            Check("trang báo ĐANG THỬ và trạng thái từng chân", page.StatusText.Contains("ĐANG THỬ") && page.RowState(5).Contains("▶"), $"{page.StatusText} | {page.RowState(5)}");
            File.WriteAllText(diFile, "0x01");   // DI1 = 1 (flow 1 ≥ 1 → tắt DO2), DI2 = 0 → DO1 tắt
            Check("đổi DI → DO1 (theo DI2) và DO2 (ngưỡng) tắt", await WaitDo(d => d >= 0 && (d & 3) == 0), $"do=0x{Do():X2}");
            Check("chu kỳ 6 s / 6 s: DO3 tự nghỉ", await WaitDo(d => d >= 0 && (d & 4) == 0, 10), $"do=0x{Do():X2}");
            var w = await rf.WriteAsync(dev, "run", 1);   // người tại chỗ bật DO1 tay → logic nhường
            await Task.Delay(1500);
            await page.RefreshForTestAsync();
            Check("bật DO1 tay lúc đang chạy → logic nhường (DO1 giữ BẬT dù DI2 = 0)", w == null && (Do() & 1) == 1 && page.RowState(1).Contains("tay"), $"err={w} do=0x{Do():X2} | {page.RowState(1)}");
            var before = Do() & ~4;   // bỏ DO3 (chu kỳ có thể đổi đúng lúc dừng)
            await page.TestForTestAsync(0);
            await Task.Delay(1500);
            Check("dừng thử → logic dừng, DO giữ nguyên", (Do() & ~4) == before, $"trước=0x{before:X2} sau=0x{Do():X2}");
            try { await c.PutOfflineAsync(new ApiOffline { Rev = saved.Rev - 1, Do = new() }); Check("lưu với Rev cũ → rev_conflict", false); }
            catch (RemoteException ex) { Check("lưu với Rev cũ → rev_conflict", ex.Code == "rev_conflict", ex.Code); }
            try { await c.PutOfflineAsync(new ApiOffline { Rev = saved.Rev, Do = new() { new OfflineRule { Ch = 2, Mode = "threshold", Field = "khong.co", On = 1, Off = 2 } } }); Check("ngưỡng với field không có → board từ chối", false); }
            catch (RemoteException ex) { Check("ngưỡng với field không có → board từ chối (câu báo tiếng Việt)", ex.Code.Contains("không có"), ex.Code); }

            // ---- CHƯƠNG TRÌNH LOGIC: chặn lệnh + hẹn giờ (luôn chạy, không cần mất mạng)
            await rf.WriteAsync(dev, "run", 0); await Task.Delay(300);
            async Task PutProg(params OfflineRule[] rules) => await c.PutOfflineAsync(new ApiOffline { Rev = (await c.OfflineAsync()).Rev, Do = rules.ToList() });
            File.WriteAllText(diFile, "0");
            await PutProg(new OfflineRule { Ch = 1, Mode = "hold", Need = new() { new OfflineCond { Di = 3, Is = 1 } }, NeedHold = true });
            await Task.Delay(800);
            var wn = await rf.WriteAsync(dev, "run", 1);
            Check("need DI3: DI3 = 0 → lệnh BẬT bị chặn (logic_need), DO1 tắt", wn != null && wn.Contains("logic_need") && (Do() & 1) == 0, $"err={wn} do=0x{Do():X2}");
            File.WriteAllText(diFile, "0x04"); await Task.Delay(800);
            wn = await rf.WriteAsync(dev, "run", 1);
            Check("need DI3: DI3 = 1 → bật được", wn == null && await WaitDo(d => (d & 1) == 1, 3), $"err={wn} do=0x{Do():X2}");
            File.WriteAllText(diFile, "0");
            Check("hold: DI3 mất → DO1 tự TẮT", await WaitDo(d => d >= 0 && (d & 1) == 0, 4), $"do=0x{Do():X2}");
            await page.RefreshForTestAsync();
            var st1 = (await c.OfflineAsync()).Status?.Ch.First(x => x.Ch == 1);
            Check("board báo mô tả chặn lệnh + lý do tự tắt", st1 != null && st1.Guard.Contains("DI3") && st1.GuardWhy.Contains("tự tắt"), $"{st1?.Guard} | {st1?.GuardWhy}");
            Check("tắt luôn được phép", await rf.WriteAsync(dev, "run", 0) == null);

            await PutProg(new OfflineRule { Ch = 1, Mode = "hold", MaxOnSec = 2 });
            await Task.Delay(800);
            wn = await rf.WriteAsync(dev, "run", 1);
            Check("maxon 2s: bật được, rồi tự TẮT", wn == null && await WaitDo(d => (d & 1) == 1, 2) && await WaitDo(d => d >= 0 && (d & 1) == 0, 5), $"err={wn} do=0x{Do():X2}");

            var do4 = (Do() & 8) != 0;
            await PutProg(new OfflineRule { Ch = 1, Mode = "hold", Block = new() { 4 } });
            await Task.Delay(800);
            wn = await rf.WriteAsync(dev, "run", 1);
            Check("block do4: DO4 đang bật → BẬT DO1 bị chặn (logic_interlock)", !do4 || (wn != null && wn.Contains("logic_interlock") && (Do() & 1) == 0), $"do4={do4} err={wn} do=0x{Do():X2}");

            var at = DateTime.UtcNow.AddHours(7).AddMinutes(1);
            await PutProg(new OfflineRule { Ch = 1, Mode = "hold", Timer = new() { new OfflineTimer { On = at.ToString("HH:mm"), Off = at.AddMinutes(1).ToString("HH:mm") } } });
            var tv = (await c.OfflineAsync()).Do.First(x => x.Ch == 1).Timer;
            Check("hẹn giờ lưu + đọc lại đúng", tv?.Count == 1 && tv[0].On == at.ToString("HH:mm"), tv?.FirstOrDefault()?.On ?? "null");
            Check("hẹn giờ: đúng phút → DO1 tự BẬT", await WaitDo(d => (d & 1) == 1, 75), $"do=0x{Do():X2}");
            Check("hẹn giờ: phút tắt → DO1 tự TẮT", await WaitDo(d => d >= 0 && (d & 1) == 0, 70), $"do=0x{Do():X2}");
            try { await PutProg(new OfflineRule { Ch = 1, Mode = "hold", Timer = new() { new OfflineTimer { On = "08:00", Off = "08:00" } } }); Check("hẹn giờ bật = tắt → board từ chối", false); }
            catch (RemoteException ex) { Check("hẹn giờ bật = tắt → board từ chối", ex.Code.Contains("khác nhau"), ex.Code); }

            SaveForm(rf, Path.Combine(outDir, "offline-page.png"));
            await c.PutOfflineAsync(new ApiOffline { Rev = (await c.OfflineAsync()).Rev, Do = new() });   // dọn: mọi chân giữ nguyên
            File.WriteAllText(diFile, "0");
            foreach (var k in rf.Config.Pack.Select(p => p.Child).Distinct().ToList()) DeviceDialog.Remove(rf, k);
            await rf.ApplyAsync("offlinetest: dọn");
        }
        catch (Exception e) { Check("chạy kiểm thử", false, RemoteClient.Explain(e) + " " + e.GetType().Name + ": " + e.Message); }
        File.WriteAllLines(Path.Combine(outDir, "offlinetest-result.txt"), log);
        rf?.Close();
        await StopAsync();
        Close();
    }
}
