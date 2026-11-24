namespace GatewayApp;

/// <summary>
/// Kiểm thử cập nhật firmware qua LAN trên board thật (--otatest KQ.txt --lan-target IP:443 --fw firmware.bin):
/// nối (PC đã ghép hoặc board đang mở cửa sổ ghép) → ghi phiên bản đang chạy → OtaAsync → chờ board khởi động lại →
/// tìm lại bằng UDP, phiên bản phải đổi. Thêm kiểm tra: file hỏng (sai SHA) bị board từ chối mà vẫn giữ bản cũ.
/// </summary>
public sealed partial class MainForm
{
    public async Task OtaTestAsync(string result)
    {
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = Environment.GetCommandLineArgs();
        var target = ArgValue(args, "--lan-target"); var fw = ArgValue(args, "--fw");
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        async Task<string> Version()
        {
            var f = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2));
            return f.FirstOrDefault(x => x.Ip.ToString() == host).Hello?.Version ?? "";
        }
        try
        {
            var bytes = File.ReadAllBytes(fw);
            var before = await Version();
            Check("tìm thấy board, đọc phiên bản", before.Length > 0, before);
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            Check("nối board bằng khoá PC", true);

            // 1) file hỏng giữa chừng: đổi 1 byte nhưng X-Sha256 tính theo file đã đổi thì board vẫn nhận — nên gửi đúng nội dung nhưng cắt cụt
            //    → Content-Length khớp, SHA khớp, image hỏng: Update.end() phải từ chối. Kiểm bằng cách cắt đuôi 4 KB.
            if (!args.Contains("--ota-only"))   // --ota-only: bỏ bước thử file cụt (nạp bản thật, không thử phá)
            {
                var cut = bytes[..(bytes.Length - 4096)];
                string bad = "";
                try { await c.OtaAsync(cut); } catch (RemoteException e) { bad = e.Code; }
                Check("firmware cụt bị từ chối", bad.Length > 0, bad);
                await Task.Delay(1500);
                var still = await Version();
                Check("board giữ bản cũ sau khi từ chối", still == before, still);
            }

            // 2) nạp bản đúng
            double last = 0; var prog = new Progress<double>(p => last = p);
            var r = await c.OtaAsync(bytes, prog);
            Check("nạp firmware đúng: board báo Ok", r.Ok, r.Msg ?? "");
            c.Dispose();
            string after = "";
            for (var k = 0; k < 40 && after.Length == 0; k++) { await Task.Delay(1000); try { after = await Version(); } catch { } if (k < 3) after = ""; }
            Check("board khởi động lại với firmware mới", after.Length > 0, $"{before} → {after}");
            if (Path.GetFileName(fw).Length > 0) log.Add($"INFO file {bytes.Length} byte");
        }
        catch (Exception e) { Check("ngoại lệ", false, RemoteClient.Explain(e) + " | " + e.GetType().Name); }
        File.WriteAllLines(result, log);
        Close();
    }
}
