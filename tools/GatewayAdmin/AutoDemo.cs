using System.Reflection;
using GatewayApp;
using GatewayApp.Ui;

namespace GatewayAdmin;

/// <summary>
/// Chế độ trình diễn (--autodemo --connect IP:cổng --token MÃ): tự "gõ phím, bấm chuột" thật trên tool Admin, chậm để quan sát:
/// nhập địa chỉ + mã, Kết nối, mở tab Cloud, nhập địa chỉ server cloud. DỪNG trước khi gửi gì ra Internet (ghép cặp/enroll do người dùng quyết định).
/// </summary>
public sealed partial class AdminForm
{
    async Task Say(string text, int ms = 2200)
    {
        Toast(text); await Task.Delay(ms);
    }

    async Task TypeAsync(TextBox c, string text, int perChar = 120)
    {
        c.Focus(); c.Text = ""; await Task.Delay(400);
        foreach (var ch in text) { c.Text += ch; c.SelectionStart = c.Text.Length; await Task.Delay(perChar); }
        await Task.Delay(600);
    }

    async Task ClickAsync(Control c)
    {
        typeof(Control).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(c, new object[] { EventArgs.Empty });
        await Task.Delay(900);
    }

    public async Task AutoDemoAsync(string address, string token)
    {
        await Task.Delay(1500);
        await Say("Trình diễn Admin: kết nối gateway rồi mở tab Cloud.", 3000);

        await Say("Bước 1/4: nhập địa chỉ gateway (IP:cổng)");
        await TypeAsync(_addr, address);
        await Say("Bước 2/4: nhập mã kết nối (hiện ở trang Kết nối admin của gateway)");
        await TypeAsync(_token, token, 160);
        await Say("Bấm Kết nối", 1200);
        await ClickAsync(_connect);
        for (var i = 0; i < 20 && !_gw.Connected; i++) await Task.Delay(300);
        if (!_gw.Connected) { await Say("Không kết nối được — kiểm tra lại mã và địa chỉ.", 4000); return; }
        await Say($"Đã kết nối. Gateway có {_gw.Config.Pack.Count} field. Vân tay gateway: {_gw.FingerprintText}", 3500);

        await Say("Bước 3/4: mở tab Cloud ở thanh bên", 2000);
        var cloud = _pages.First(p => p.Page == _cloud);
        await ClickAsync(cloud.Btn);
        await Say("Tab Cloud: bật/tắt đồng bộ, địa chỉ server, mã ghép cặp, mã QR của tem, Enroll, cấu hình nâng cao.", 4500);

        await Say("Bước 4/4: nhập địa chỉ server cloud");
        await TypeAsync(_cloud.Api, "https://plc.dieukhientudong.net");
        await Say("Đến đây dừng. Để ghép cặp: nhập MÃ GHÉP CẶP admin phát rồi bấm \"Gửi bản khai cho admin\"; hoặc dán MÃ QR của tem rồi bấm \"Enroll từ QR\".", 8000);
        await Say("Chưa gửi gì lên Internet. Đang chờ bạn nhập mã.", 6000);
    }
}
