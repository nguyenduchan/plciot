using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Biểu tượng QR nhỏ ở thanh trên: hiện khi gateway đã có QR tem (GatewayQr, lưu trong cấu hình nên mở lại app vẫn còn);
/// bấm vào thì phóng to để user quét bằng điện thoại, kèm sao chép link / lưu ảnh. Chưa đăng ký thì ẩn.
/// QR là link <c>{server}/login.html?claim=…</c>: quét bằng camera điện thoại hay dán vào webapp đều nhận.
/// </summary>
sealed class QrIcon : Control
{
    readonly IGatewayApp _app;
    readonly Func<string> _apiFallback;
    readonly ToolTip _tip = new();
    Bitmap? _thumb;
    string _shown = "";
    bool _hot;

    public QrIcon(IGatewayApp app, Func<string>? apiFallback = null)
    {
        _app = app; _apiFallback = apiFallback ?? (() => "");
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Size = new Size(40, 40); Cursor = Cursors.Hand; Visible = false;
        _tip.SetToolTip(this, "Mã QR cho user quét — bấm để phóng to");
        MouseEnter += (_, _) => { _hot = true; Invalidate(); };
        MouseLeave += (_, _) => { _hot = false; Invalidate(); };
        Click += (_, _) => Enlarge();
    }

    string Url()
    {
        var qr = _app.Config.GatewayQr?.Trim() ?? "";
        if (qr.Length == 0) return "";
        var api = (_app.Config.CloudApiUrl ?? "").Trim();
        if (api.Length == 0) api = _apiFallback().Trim();
        return api.Length == 0 ? qr : $"{api.TrimEnd('/')}/login.html?claim={qr}";
    }

    static Bitmap Render(string text, int ppm)
    {
        using var gen = new QRCoder.QRCodeGenerator();
        using var data = gen.CreateQrCode(text, QRCoder.QRCodeGenerator.ECCLevel.L);
        using var ms = new MemoryStream(new QRCoder.PngByteQRCode(data).GetGraphic(ppm));
        using var raw = Image.FromStream(ms);
        return new Bitmap(raw);   // nhân bản để không phụ thuộc luồng đã đóng
    }

    /// <summary>Gọi mỗi nhịp giao diện: hiện/ẩn theo GatewayQr; vẽ lại ảnh nhỏ chỉ khi link đổi.</summary>
    public void Update()
    {
        var url = Url();
        Visible = url.Length > 0;
        if (url == _shown) return;
        _shown = url;
        _thumb?.Dispose(); _thumb = url.Length == 0 ? null : Render(url, 3);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var b = new SolidBrush(Color.White)) g.FillRectangle(b, r);
        if (_thumb != null) g.DrawImage(_thumb, new Rectangle(3, 3, Width - 7, Height - 7));
        using var pen = new Pen(_hot ? Theme.Teal : Theme.Border, _hot ? 2 : 1);
        g.DrawRectangle(pen, r);
    }

    void Enlarge()
    {
        var u = Url(); if (u.Length == 0) return;
        var c = _app.Config;
        using var f = new Form { Text = $"QR {c.Site}/{c.Device}", ClientSize = new Size(480, 600), StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = false };
        using var big = Render(u, 10);
        var pic = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.White, Image = big, Padding = new Padding(10), Location = new Point(20, 20), Size = new Size(440, 440) };
        var info = new Label { AutoSize = false, ForeColor = Theme.Muted, Font = Theme.Normal, BackColor = Color.Transparent, Location = new Point(20, 470), Size = new Size(440, 54),
            Text = $"Tem {c.Site}/{c.Device} — QR không hết hạn.\n" + (c.CloudSendData ? "Đã có user: gateway đang gửi data lên cloud." : "Chưa có user quét: đưa QR này cho user quét trên webapp để bắt đầu gửi data.") };
        var copy = new FlatButton { Caption = "Sao chép link", Width = 200, Location = new Point(20, 536) };
        var save = new FlatButton { Caption = "Lưu ảnh QR…", Width = 200, Location = new Point(260, 536) };
        copy.Click += (_, _) => { Clipboard.SetText(u); _app.Toast("Đã sao chép link QR — gửi cho user mở trên điện thoại."); };
        save.Click += (_, _) =>
        {
            using var d = new SaveFileDialog { Filter = "PNG|*.png", FileName = $"qr-{c.Site}-{c.Device}.png" };
            if (d.ShowDialog(f) != DialogResult.OK) return;
            using var bmp = Render(u, 12);
            bmp.Save(d.FileName, System.Drawing.Imaging.ImageFormat.Png);
            _app.Toast("Đã lưu ảnh QR.");
        };
        f.Controls.AddRange(new Control[] { pic, info, copy, save });
        f.ShowDialog(FindForm());
    }

    protected override void Dispose(bool disposing) { if (disposing) { _thumb?.Dispose(); _tip.Dispose(); } base.Dispose(disposing); }
}
