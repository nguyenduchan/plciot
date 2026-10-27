using System.Windows;
using System.IO;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using QRCoder;

namespace Plciot.Solution.Conveyor;

/// <summary>Hộp thoại xác nhận cùng chủ đề tối (MessageBox mặc định của Windows sáng, lạc tông).</summary>
public static class Dialogs
{
    public static bool Confirm(Window owner, string message, string ok = "Đồng ý", bool danger = true)
    {
        var result = false;
        var win = new Window
        {
            Owner = owner, Title = "Xác nhận", Width = 380, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, ShowInTaskbar = false,
            Style = (Style)Application.Current.FindResource("WindowBase"),
        };
        var yes = new Button { Content = ok, Style = (Style)Application.Current.FindResource(danger ? "Danger" : "Primary"), IsDefault = true };
        var no = new Button { Content = "Huỷ", IsCancel = true };
        yes.Click += (_, _) => { result = true; win.Close(); };
        win.Content = new StackPanel
        {
            Margin = new Thickness(24, 20, 24, 12),
            Children =
            {
                new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 18) },
                new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Children = { no, yes } },
            },
        };
        win.ShowDialog();
        return result;
    }

    /// <summary>Hiện mã QR của địa chỉ webapp để quét bằng điện thoại.</summary>
    public static void ShowQr(Window owner, string url)
    {
        using var gen = new QRCodeGenerator();
        using var data = gen.CreateQrCode(url, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(data).GetGraphic(12);
        var bmp = new BitmapImage();
        using (var ms = new MemoryStream(png)) { bmp.BeginInit(); bmp.CacheOption = BitmapCacheOption.OnLoad; bmp.StreamSource = ms; bmp.EndInit(); }
        var win = new Window
        {
            Owner = owner, Title = "Mã QR cho điện thoại", Width = 380, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, ShowInTaskbar = false,
            Style = (Style)Application.Current.FindResource("WindowBase"),
        };
        var close = new Button { Content = "Đóng", IsCancel = true, IsDefault = true, HorizontalAlignment = HorizontalAlignment.Right };
        close.Click += (_, _) => win.Close();
        win.Content = new StackPanel
        {
            Margin = new Thickness(24, 20, 24, 12),
            Children =
            {
                new TextBlock { Text = "Quét bằng camera điện thoại để mở ứng dụng", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) },
                new Border { Background = System.Windows.Media.Brushes.White, Padding = new Thickness(10), HorizontalAlignment = HorizontalAlignment.Center,
                    Child = new Image { Source = bmp, Width = 260, Height = 260, SnapsToDevicePixels = true } },
                new TextBox { Text = url, IsReadOnly = true, Margin = new Thickness(0, 12, 0, 12), TextAlignment = TextAlignment.Center },
                close,
            },
        };
        win.ShowDialog();
    }
}
