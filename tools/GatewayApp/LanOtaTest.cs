namespace GatewayApp;

/// <summary>
/// Kiểm thử cập nhật firmware CÓ DUYỆT qua LAN (--otatest KQ.txt --lan-target IP:CỔNG --fw firmware.bin [--io-data SIM_DATA] [--ota-only]), bản Debug.
/// firmware.bin phải có firmware.bin.json (sign-mcu-firmware.js). Board thật hoặc gw-sim:
///   1. không chữ ký → ota_unsigned; chữ ký cho phiên bản khác → ota_bad_signature; file cụt (SHA khác bản đã ký) → ota_bad_signature
///   2. board CÓ CHỦ (giả lập bằng cách đặt CloudCmdKey) mà chưa được chủ trạm duyệt → ota_not_approved (rồi trả cấu hình cũ)
///   3. nhật ký sự kiện board có các lần từ chối (cảnh báo bảo mật)
///   4. board chưa có chủ + đúng chữ ký → nạp được; board thật: khởi động lại với phiên bản mới; gw-sim: SIM_DATA/ota-new.bin = file gửi
/// </summary>
public sealed partial class MainForm
{
    public async Task OtaTestAsync(string result)
    {
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var fw = ArgValue(args, "--fw"); var data = ArgValue(args, "--io-data");
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        async Task<string> Code(Func<Task> f) { try { await f(); return "ok"; } catch (RemoteException e) { return e.Code; } }
        try
        {
            var bytes = File.ReadAllBytes(fw);
            using var sj = System.Text.Json.JsonDocument.Parse(File.ReadAllText(fw + ".json"));
            var ver = sj.RootElement.GetProperty("Version").GetString()!; var sig = sj.RootElement.GetProperty("Sig").GetString()!;
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var st = await c.OtaStateAsync();
            var before = st.GetProperty("Version").GetString() ?? "";
            Check("nối board, đọc trạng thái cập nhật", before.Length > 0, $"{before}, có chủ: {st.GetProperty("Enrolled").GetBoolean()}");

            Check("không chữ ký → ota_unsigned", await Code(() => c.OtaAsync(bytes, "", "")) == "ota_unsigned");
            Check("chữ ký của phiên bản khác → ota_bad_signature", await Code(() => c.OtaAsync(bytes, ver + "x", sig)) == "ota_bad_signature");
            Check("file cụt (SHA khác bản đã ký) → ota_bad_signature", await Code(() => c.OtaAsync(bytes[..(bytes.Length - 4096)], ver, sig)) == "ota_bad_signature");

            if (!st.GetProperty("Enrolled").GetBoolean() && !args.Contains("--ota-only"))
            {
                // giả lập board CÓ CHỦ: đặt khoá ký của server → chưa có chủ trạm duyệt thì không nạp được
                var cfg = await c.ConfigAsync();
                var keep = cfg.Config.CloudCmdKey;
                cfg.Config.CloudCmdKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWGNiC3CNpaoPIHa9XSExgyjBoGYOycqAdZV-neVMMw9mR7FZUL6Q4yZXO5dYFsISAgT0AMIOkJ18RctHe5zvpw";
                await c.PutConfigAsync(cfg); await Task.Delay(800);
                Check("board có chủ: trạng thái Enrolled, chưa được duyệt", (await c.OtaStateAsync()) is var s2 && s2.GetProperty("Enrolled").GetBoolean() && !s2.GetProperty("Approved").GetBoolean());
                Check("board có chủ, chưa duyệt, đúng chữ ký → ota_not_approved", await Code(() => c.OtaAsync(bytes, ver, sig)) == "ota_not_approved");
                cfg.Config.CloudCmdKey = keep; await c.PutConfigAsync(cfg); await Task.Delay(800);
            }
            var ev = (await c.EventsAsync()).GetProperty("Events").EnumerateArray().Select(e => e.GetProperty("k").GetString()).ToList();
            Check("nhật ký board ghi các lần từ chối (ota_badsig, ota_denied)", ev.Contains("ota_badsig") && (args.Contains("--ota-only") || ev.Contains("ota_denied")), string.Join(",", ev.TakeLast(8)));

            if ((await c.OtaStateAsync()).GetProperty("Enrolled").GetBoolean()) { Check("board có chủ thật: bỏ bước nạp (cần chủ trạm duyệt trên webapp)", true); }
            else
            {
                if (data.Length > 0) File.Delete(Path.Combine(data, "ota-new.bin"));
                var r = await c.OtaAsync(bytes, ver, sig);
                Check("board chưa có chủ + đúng chữ ký → nạp được", r.Ok, r.Msg ?? "");
                c.Dispose();
                if (data.Length > 0)
                {
                    var f = Path.Combine(data, "ota-new.bin");
                    Check("gw-sim: firmware ghi ra đúng từng byte", File.Exists(f) && File.ReadAllBytes(f).SequenceEqual(bytes));
                }
                else
                {
                    string after = "";
                    for (var k = 0; k < 40 && after.Length == 0; k++)
                    {
                        await Task.Delay(1500);
                        try { var f = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2)); after = f.FirstOrDefault(x => x.Ip.ToString() == host).Hello?.Version ?? ""; } catch { }
                        if (after == before) after = "";
                    }
                    Check("board khởi động lại với firmware mới", after == ver, $"{before} → {after}");
                }
            }
        }
        catch (Exception e) { Check("ngoại lệ", false, RemoteClient.Explain(e) + " | " + e.GetType().Name); }
        File.WriteAllLines(result, log);
        Close();
    }
}
