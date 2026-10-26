using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Plciot.Scada;

namespace Plciot.Solution.Conveyor;

/// <summary>
/// Cửa sổ của giải pháp Conveyor. Chỉ dùng <see cref="IScadaView"/> từ <see cref="SolutionContext"/>: ở máy chính là lõi (điều khiển
/// THẲNG PLC), ở máy màn hình phụ là client tới máy chính. Quyền điều khiển lấy từ <see cref="IScadaView.CanControl"/> — cửa sổ không
/// tự quyết; chính sách (một/nhiều màn hình, điện thoại, màn hình phụ) do framework và <c>ConveyorSolution</c> đặt.
/// </summary>
public partial class MainWindow : Window
{
    static readonly PlcSource[] Sources =
    {
        PlcSource.Gateway, PlcSource.ModbusTcp, PlcSource.S7, PlcSource.EtherNetIp,
        PlcSource.MitsubishiMc, PlcSource.OmronFins, PlcSource.BeckhoffAds, PlcSource.OpcUa,
    };

    readonly SolutionContext _ctx;
    readonly IScadaView _view;
    readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(250) };

    public MainWindow(SolutionContext ctx)
    {
        _ctx = ctx;
        _view = ctx.View;
        InitializeComponent();
        Title = $"SCADA · {ctx.Solution.Name}";
        LoadSettingsToUi(ctx.Config);
        _timer.Tick += (_, _) => Refresh();
        _timer.Start();
        Closed += (_, _) => _timer.Stop();
    }

    static Border Led(bool on, string name)
    {
        var dot = new System.Windows.Shapes.Ellipse { Width = 12, Height = 12, Margin = new Thickness(0, 0, 6, 0), Fill = on ? Brushes.LimeGreen : Brushes.LightGray };
        return new Border
        {
            Margin = new Thickness(0, 0, 8, 8), Padding = new Thickness(10, 5, 10, 5), CornerRadius = new CornerRadius(8), Background = new SolidColorBrush(Color.FromRgb(0xF2, 0xF4, 0xF7)),
            Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { dot, new TextBlock { Text = name } } },
        };
    }

    static void Fill(Panel p, int bits, string prefix)
    {
        p.Children.Clear();
        for (var i = 0; i < 8; i++) p.Children.Add(Led((bits >> i & 1) == 1, prefix + i));
    }

    void Refresh()
    {
        var s = _view.State;
        var online = s.Status == "online" && s.Fresh;
        var control = online && _view.CanControl;
        TitleText.Text = $"{_ctx.Solution.Name} · {_view.Site}/{_view.Device}" + (_ctx.IsMainStation ? "" : " · màn hình phụ");
        PlcText.Text = online ? "PLC online" : s.Status == "plc_fault" ? "PLC lỗi" : "PLC mất kết nối";
        PlcText.Foreground = online ? Brushes.Green : Brushes.Firebrick;
        CloudText.Text = _ctx.Host != null
            ? _ctx.Host.Cloud switch { CloudState.Connected => "Điện thoại ✓", CloudState.Connecting => "Điện thoại…", CloudState.Disabled => "Điện thoại tắt", _ => "Điện thoại ✗" }
            : "";
        KConv.Text = s.ConveyorText;
        KCount.Text = $"{s.Count} / {(s.Target == 0 ? "∞" : s.Target.ToString())}";
        KTotal.Text = s.Total.ToString();
        KMode.Text = s.Manual ? "Thủ công" : "Tự động";
        KRun.Text = $"{s.RunSeconds / 3600} giờ {s.RunSeconds / 60 % 60:00} phút";
        KPump.Text = s.PumpStarts.ToString();
        AlarmPanel.Children.Clear();
        AlarmPanel.Children.Add(Led(s.Estop, "E-stop"));
        AlarmPanel.Children.Add(Led(s.LevelFault, "Lỗi cảm biến mức"));
        Fill(XPanel, s.Inputs, "X");
        Fill(YPanel, s.Outputs, "Y");
        SysText.Text = _view.InfoLine;

        CtlHint.Text = !_view.CanControl ? "Màn hình này chỉ để giám sát."
            : online ? "Lệnh đi thẳng xuống PLC. Khoá liên động an toàn (E-stop, đủ số lượng) luôn do PLC quyết định." : "PLC chưa sẵn sàng.";
        foreach (var b in new Control[] { BAuto, BMan, BSetTarget, BReset }) b.IsEnabled = control;
        BStart.IsEnabled = control && !s.RunRequested;
        BStop.IsEnabled = control && s.RunRequested;
        SwPanel.Children.Clear();
        for (var i = 0; i < 8; i++)
        {
            var idx = i;
            var bit = (s.ManualMask >> i & 1) == 1;
            var b = new Button { Content = "Y" + i, IsEnabled = control && s.Manual && i != 1, Background = bit ? Brushes.LightGreen : SystemColors.ControlBrush };
            b.Click += async (_, _) => await Send(4, _view.State.ManualMask ^ (1 << idx));
            SwPanel.Children.Add(b);
        }
        if (!TargetBox.IsKeyboardFocused) TargetBox.Text = s.Target.ToString();
        AckText.Text = s.LastAck == null ? "" : "Phản hồi cuối: " + s.LastAck;
        var log = string.Join("\n", _view.RecentLog);
        if (LogBox.Text != log) { LogBox.Text = log; LogBox.ScrollToEnd(); }
    }

    async Task Send(int a, int v)
    {
        var err = await _view.WriteAsync(a, v);
        if (err != null) AckText.Text = "Lệnh bị từ chối: " + err;
    }

    void OnAuto(object s, RoutedEventArgs e) => _ = Send(3, 0);
    void OnMan(object s, RoutedEventArgs e) => _ = Send(3, 1);
    void OnStart(object s, RoutedEventArgs e) => _ = Send(6, 1);
    void OnStop(object s, RoutedEventArgs e) => _ = Send(6, 0);
    void OnSetTarget(object s, RoutedEventArgs e)
    {
        if (int.TryParse(TargetBox.Text, out var v) && v is >= 0 and <= 65535) _ = Send(7, v);
        else AckText.Text = "Giá trị 0–65535";
    }
    void OnReset(object s, RoutedEventArgs e)
    {
        if (MessageBox.Show("Xoá số đếm hiện tại về 0?", "Xác nhận", MessageBoxButton.YesNo) == MessageBoxResult.Yes) _ = Send(9, 1);
    }

    // ------------------------------------------------------------------ cài đặt (chỉ thông số hiện trường; chế độ do giải pháp khoá)
    void LoadSettingsToUi(ScadaConfig c)
    {
        ModeText.Text = $"Chế độ (do giải pháp '{_ctx.Solution.Name}' quyết định, không đổi bằng cài đặt): "
            + $"{(c.Station == StationRole.Screen ? "MÁY MÀN HÌNH PHỤ" : "máy chính")}, {(c.Topology == Topology.SingleScreen ? "MỘT màn hình (không client-server)" : "NHIỀU màn hình")}, "
            + $"màn hình phụ {(c.Control.RemoteScreens ? "được điều khiển" : "chỉ xem")}, điện thoại {c.Mobile}.";
        ScreensText.Text = c.WebActive ? $"Màn hình phụ mở trình duyệt hoặc chạy ứng dụng ở chế độ màn hình phụ tới http://<IP máy này>:{c.WebPort}" : "";
        SSite.Text = c.Site; SDevice.Text = c.Device;
        SSource.SelectedIndex = Array.IndexOf(Sources, c.Source);
        SHost.Text = c.PlcHost; SPort.Text = c.PlcPort.ToString();
        SCloudHost.Text = c.CloudHost; SCloudPort.Text = c.CloudPort.ToString(); SCloudUser.Text = c.CloudUser;
        SCloudPass.Password = c.CloudPassword; SPin.Text = c.CloudPinSha256;
    }

    void OnSaveSettings(object sender, RoutedEventArgs e)
    {
        try
        {
            var c = ConfigStore.Load(_ctx.ConfigPath);
            c.Site = SSite.Text.Trim(); c.Device = SDevice.Text.Trim();
            c.Source = Sources[Math.Max(0, SSource.SelectedIndex)];
            c.PlcHost = SHost.Text.Trim(); c.PlcPort = int.Parse(SPort.Text);
            c.CloudHost = SCloudHost.Text.Trim(); c.CloudPort = int.Parse(SCloudPort.Text); c.CloudUser = SCloudUser.Text.Trim();
            c.CloudPassword = SCloudPass.Password; c.CloudPinSha256 = SPin.Text.Trim();
            _ctx.Solution.Enforce(c);
            var err = c.Validate();
            if (err != null) { SettingsMsg.Text = err; return; }
            ConfigStore.Save(_ctx.ConfigPath, c);
            SettingsMsg.Text = "Đã lưu. Ứng dụng sẽ chạy lại…";
            var psi = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false };
            foreach (var a in Environment.GetCommandLineArgs().Skip(1)) psi.ArgumentList.Add(a);
            Process.Start(psi);
            Application.Current.Shutdown();
        }
        catch (Exception ex) when (ex is FormatException or OverflowException) { SettingsMsg.Text = "Giá trị không hợp lệ: " + ex.Message; }
    }
}
