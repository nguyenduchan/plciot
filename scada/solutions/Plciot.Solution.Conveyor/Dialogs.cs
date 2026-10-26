using System.Windows;
using System.Windows.Controls;

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
}
