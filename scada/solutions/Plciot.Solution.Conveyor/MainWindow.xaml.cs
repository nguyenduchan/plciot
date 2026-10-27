using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using Plciot.Scada;
using Plciot.Solution.Conveyor.Auth;

namespace Plciot.Solution.Conveyor;

/// <summary>
/// Cửa sổ của giải pháp Conveyor, phong cách Grafana tối. Chỉ dùng <see cref="IScadaView"/> từ <see cref="SolutionContext"/>:
/// ở máy chính là lõi (điều khiển THẲNG PLC), ở máy màn hình phụ là client tới máy chính.
/// Quyền điều khiển = chính sách của framework (<see cref="IScadaView.CanControl"/>) VÀ vai trò người đăng nhập tại máy này.
/// Mặc định là chế độ chỉ xem (không cần đăng nhập) để màn hình treo tường luôn hiển thị.
/// </summary>
public partial class MainWindow : Window
{
    static readonly PlcSource[] Sources =
    {
        PlcSource.Gateway, PlcSource.ModbusTcp, PlcSource.ModbusRtu, PlcSource.S7, PlcSource.EtherNetIp,
        PlcSource.MitsubishiMc, PlcSource.OmronFins, PlcSource.BeckhoffAds, PlcSource.OpcUa,
    };

    static readonly Dictionary<string, string> Titles = new()
    {
        ["Overview"] = "Tổng quan", ["Control"] = "Điều khiển", ["Log"] = "Nhật ký", ["Settings"] = "Cài đặt", ["Users"] = "Người dùng",
    };

    sealed record UserRow(string Name, string RoleText, string StateText, string CreatedText, UserRecord Raw);

    readonly SolutionContext _ctx;
    readonly IScadaView _view;
    readonly Session _session;
    readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(250) };
    string _page = "Overview";
    DateTime _lastSample = DateTime.MinValue, _lastAudit = DateTime.MinValue, _toastUntil;
    readonly Queue<(DateTime t, long total)> _totals = new();

    public MainWindow(SolutionContext ctx)
    {
        _ctx = ctx;
        _view = ctx.View;
        var dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(ctx.ConfigPath)) ?? ".";
        _session = new Session(new UserStore(System.IO.Path.Combine(dir, "users.json")), new AuditLog(System.IO.Path.Combine(dir, "audit")));
        InitializeComponent();
        Title = $"SCADA · {ctx.Solution.Name}";
        // máy nhỏ/DPI cao: không cho cửa sổ cao hơn vùng làm việc (nếu không thanh dưới của thanh bên bị cắt)
        MaxHeight = SystemParameters.WorkArea.Height; MaxWidth = SystemParameters.WorkArea.Width;
        foreach (var r in new[] { Role.Viewer, Role.Operator, Role.Engineer, Role.Admin })
        {
            EditRole.Items.Add(new ComboBoxItem { Content = Roles.Display(r), Tag = r });
            NewRole.Items.Add(new ComboBoxItem { Content = Roles.Display(r), Tag = r });
        }
        NewRole.SelectedIndex = 1;
        LoadSettingsToUi(ctx.Config);

        // mọi thao tác của người dùng làm mới đồng hồ tự đăng xuất
        PreviewMouseDown += (_, _) => _session.Touch();
        PreviewKeyDown += (_, _) => _session.Touch();
        _session.Changed += OnSessionChanged;
        OnSessionChanged();
        ShowPage("Overview");

        _timer.Tick += (_, _) => Refresh();
        _timer.Start();
        Closed += (_, _) => { _timer.Stop(); _session.SignOut("đóng ứng dụng"); };
        // lần đầu chạy chưa có tài khoản: mời tạo quản trị viên ngay (có thể bỏ qua, vẫn xem được)
        Loaded += (_, _) => { if (_session.Store.NeedsSetup) OpenLogin(); };
    }

    Brush Res(string key) => (Brush)FindResource(key);

    // ------------------------------------------------------------------ đăng nhập / phân quyền
    void OpenLogin()
    {
        if (new LoginDialog(_session) { Owner = this }.ShowDialog() == true) Notify($"Xin chào {_session.Actor} ({Roles.Display(_session.Role!.Value)})");
    }

    void OnShowQr(object s, RoutedEventArgs e) => Dialogs.ShowQr(this, MobileUrl.Resolve(_ctx.ConfigPath));

    void OnAuthButton(object s, RoutedEventArgs e)
    {
        if (_session.User == null) OpenLogin();
        else { _session.SignOut(); Notify("Đã đăng xuất. Màn hình ở chế độ chỉ xem."); }
    }

    /// <summary>Đòi quyền; chưa đăng nhập thì mở hộp thoại đăng nhập rồi kiểm tra lại.</summary>
    bool Need(Permission p)
    {
        if (_session.Can(p)) return true;
        if (_session.User == null) OpenLogin();
        if (_session.Can(p)) return true;
        if (_session.User != null) Notify("Vai trò của bạn không có quyền này.");
        return false;
    }

    void OnSessionChanged()
    {
        var u = _session.User;
        UserName.Text = u?.Name ?? "Chế độ chỉ xem";
        UserRole.Text = u == null ? "chưa đăng nhập" : Roles.Display(u.Role);
        AvatarText.Text = u == null ? "?" : u.Name[..1].ToUpperInvariant();
        Avatar.Background = u == null ? Res("Off") : Res(u.Role >= Role.Admin ? "Red" : u.Role >= Role.Engineer ? "Orange" : "Blue");
        AuthBtn.Content = u == null ? "Đăng nhập" : "Đăng xuất";
        AuthBtn.Style = (Style)FindResource(u == null ? "Primary" : "Danger");
        NavUsers.Visibility = _session.Can(Permission.ManageUsers) ? Visibility.Visible : Visibility.Collapsed;
        SettingsPanel.IsEnabled = _session.Can(Permission.EditSettings);
        SetBanner.Visibility = _session.Can(Permission.EditSettings) ? Visibility.Collapsed : Visibility.Visible;
        if (_page == "Users" && !_session.Can(Permission.ManageUsers)) { NavOverview.IsChecked = true; ShowPage("Overview"); }
        if (_page == "Users") RefreshUsers();
    }

    void Notify(string text)
    {
        ToastText.Text = text; Toast.Visibility = Visibility.Visible; _toastUntil = DateTime.Now.AddSeconds(4);
    }

    // ------------------------------------------------------------------ điều hướng
    void OnNav(object s, RoutedEventArgs e)
    {
        if (s is RadioButton { Tag: string page }) ShowPage(page);
    }

    void ShowPage(string page)
    {
        if (ViewOverview == null) return;   // sự kiện Checked chạy trong lúc InitializeComponent
        _page = page;
        ViewOverview.Visibility = page == "Overview" ? Visibility.Visible : Visibility.Collapsed;
        ViewControl.Visibility = page == "Control" ? Visibility.Visible : Visibility.Collapsed;
        ViewLog.Visibility = page == "Log" ? Visibility.Visible : Visibility.Collapsed;
        ViewSettings.Visibility = page == "Settings" ? Visibility.Visible : Visibility.Collapsed;
        ViewUsers.Visibility = page == "Users" ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = Titles[page];
        if (page == "Users") RefreshUsers();
    }

    // ------------------------------------------------------------------ giao diện
    Border Led(bool on, string name, string onBrush = "Green")
    {
        var dot = new Ellipse { Width = 10, Height = 10, Margin = new Thickness(0, 0, 7, 0), Fill = on ? Res(onBrush) : Res("Off") };
        return new Border
        {
            Margin = new Thickness(0, 0, 8, 8), Padding = new Thickness(9, 5, 11, 5), CornerRadius = new CornerRadius(2),
            Background = new SolidColorBrush(Color.FromRgb(0x11, 0x12, 0x17)), BorderBrush = Res("Line"), BorderThickness = new Thickness(1),
            Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { dot, new TextBlock { Text = name } } },
        };
    }

    void Fill(Panel p, int bits, string prefix, string onBrush)
    {
        p.Children.Clear();
        for (var i = 0; i < 8; i++) p.Children.Add(Led((bits >> i & 1) == 1, prefix + i, onBrush));
    }

    void Refresh()
    {
        var now = DateTime.Now;
        if (_session.CheckIdle()) Notify("Hết thời gian không thao tác — đã về chế độ chỉ xem.");
        if (Toast.Visibility == Visibility.Visible && now > _toastUntil) Toast.Visibility = Visibility.Collapsed;
        ClockText.Text = now.ToString("dd/MM/yyyy HH:mm:ss");
        var left = _session.IdleLeft;
        IdleText.Text = left is { } l ? $"Tự đăng xuất sau {Math.Max(0, (int)l.TotalMinutes)}:{Math.Max(0, l.Seconds):00}" : "Xem không cần đăng nhập";

        var s = _view.State;
        var online = s.Status == "online" && s.Fresh;
        var control = online && _view.CanControl && _session.Can(Permission.Control);
        SideSite.Text = $"{_view.Site} / {_view.Device}" + (_ctx.IsMainStation ? "" : " · màn hình phụ");
        var fault = s.Status == "plc_fault";
        PlcText.Text = online ? "PLC online" : fault ? "PLC lỗi" : "PLC mất kết nối";
        PlcText.Foreground = online ? Res("Green") : Res("Red");
        PlcDot.Fill = online ? Res("Green") : Res("Red");
        PlcPill.Background = new SolidColorBrush(online ? Color.FromRgb(0x1f, 0x3a, 0x22) : Color.FromRgb(0x3a, 0x1d, 0x22));
        CloudText.Text = _ctx.Host != null
            ? _ctx.Host.Cloud switch { CloudState.Connected => "Điện thoại ● kết nối", CloudState.Connecting => "Điện thoại … đang nối", CloudState.Disabled => "Điện thoại tắt", _ => "Điện thoại ✗ mất kết nối" }
            : "";

        // ---- tổng quan
        KConv.Text = s.ConveyorText;
        KConv.Foreground = s.Conveyor switch { 1 => Res("Green"), 3 => Res("Red"), 2 => Res("Yellow"), _ => Res("Orange") };
        KMode.Text = s.Manual ? "Chế độ thủ công" : "Chế độ tự động";
        KCount.Text = s.Count.ToString();
        KTarget.Text = s.Target == 0 ? "Mục tiêu: không giới hạn" : $"Mục tiêu: {s.Target}";
        KTotal.Text = s.Total.ToString("N0");
        KRun.Text = $"Chạy {s.RunSeconds / 3600} giờ {s.RunSeconds / 60 % 60:00} phút";
        PumpText.Text = $"Khởi động bơm: {s.PumpStarts}";

        if (now - _lastSample >= TimeSpan.FromSeconds(1))
        {
            _lastSample = now;
            _totals.Enqueue((now, s.Total));
            while (_totals.Count > 0 && now - _totals.Peek().t > TimeSpan.FromSeconds(60)) _totals.Dequeue();
            var first = _totals.Peek();
            var span = Math.Max(1, (now - first.t).TotalSeconds);
            // đếm theo số nguyên nên cửa sổ ngắn cho tốc độ nhảy loạn: đợi đủ 15 giây rồi mới tính/vẽ
            var rate = online ? Math.Max(0, (s.Total - first.total) * 60.0 / span) : 0;
            var steady = span >= 15;
            KRate.Text = !online ? "0.0" : steady ? rate.ToString("0.0") : "…";
            if (online) { if (steady) ChartRate.Add(rate); ChartCount.Add(s.Count); }
        }

        AlarmPanel.Children.Clear();
        AlarmPanel.Children.Add(Led(s.Estop, "E-stop", "Red"));
        AlarmPanel.Children.Add(Led(s.LevelFault, "Cảm biến mức", "Red"));
        Fill(XPanel, s.Inputs, "X", "Green");
        Fill(YPanel, s.Outputs, "Y", "Orange");
        SysText.Text = _view.InfoLine;

        // ---- điều khiển
        CtlBanner.Visibility = control ? Visibility.Collapsed : Visibility.Visible;
        CtlHint.Text = !_view.CanControl ? "Màn hình này chỉ để giám sát."
            : _session.User == null ? "Đang ở chế độ chỉ xem. Bấm \"Đăng nhập\" (vai trò Vận hành trở lên) để điều khiển."
            : !_session.Can(Permission.Control) ? $"Tài khoản \"{_session.Actor}\" chỉ có quyền xem."
            : "PLC chưa sẵn sàng.";
        foreach (var b in new Control[] { BAuto, BMan, BSetTarget, BReset }) b.IsEnabled = control;
        BStart.IsEnabled = control && !s.RunRequested;
        BStop.IsEnabled = control && s.RunRequested;
        var swKey = $"{control}|{s.Manual}|{s.ManualMask}";
        if (SwPanel.Children.Count != 8 || !Equals(SwPanel.Tag, swKey))
        {
            SwPanel.Children.Clear();
            for (var i = 0; i < 8; i++)
            {
                var idx = i;
                var bit = (s.ManualMask >> i & 1) == 1;
                var b = new Button
                {
                    Content = "Y" + i, MinWidth = 52, IsEnabled = control && s.Manual && i != 1,
                    Background = bit ? new SolidColorBrush(Color.FromRgb(0x1f, 0x3a, 0x22)) : new SolidColorBrush(Color.FromRgb(0x22, 0x25, 0x2b)),
                    BorderBrush = bit ? Res("Green") : new SolidColorBrush(Color.FromRgb(0x34, 0x36, 0x3c)),
                };
                b.Click += async (_, _) => await Send(4, _view.State.ManualMask ^ (1 << idx));
                SwPanel.Children.Add(b);
            }
            SwPanel.Tag = swKey;
        }
        if (!TargetBox.IsKeyboardFocused) TargetBox.Text = s.Target.ToString();
        AckText.Text = s.LastAck == null ? "" : "Phản hồi cuối: " + s.LastAck;

        // ---- nhật ký
        if (_page == "Log")
        {
            var log = string.Join("\n", _view.RecentLog);
            if (LogBox.Text != log) { LogBox.Text = log; LogBox.ScrollToEnd(); }
            if (now - _lastAudit > TimeSpan.FromSeconds(2))
            {
                _lastAudit = now;
                var audit = _session.Can(Permission.ManageUsers) ? string.Join("\n", _session.Audit.Recent(300)) : "Cần đăng nhập vai trò Quản trị để xem nhật ký kiểm toán.";
                if (AuditBox.Text != audit) { AuditBox.Text = audit; AuditBox.ScrollToEnd(); }
            }
        }
    }

    async Task Send(int a, int v)
    {
        if (!Need(Permission.Control)) return;
        var err = await _view.WriteAsync(a, v, _session.Actor);   // tên người đi vào nhật ký lõi (actor)
        _session.Audit.Write(_session.Actor, "điều khiển", $"D{a} = {v}" + (err == null ? "" : $" — bị từ chối: {err}"));
        if (err != null) { AckText.Text = "Lệnh bị từ chối: " + err; Notify("Lệnh bị từ chối: " + err); }
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
        if (Dialogs.Confirm(this, "Xoá số đếm hiện tại về 0?", "Xoá số đếm")) _ = Send(9, 1);
    }

    // ------------------------------------------------------------------ cài đặt (chỉ thông số hiện trường; chế độ do giải pháp khoá)
    void LoadSettingsToUi(ScadaConfig c)
    {
        ModeText.Text = $"Chế độ do giải pháp '{_ctx.Solution.Name}' quyết định, không đổi bằng cài đặt: "
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
        if (!Need(Permission.EditSettings)) return;
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
            _session.Audit.Write(_session.Actor, "đổi cài đặt", $"PLC {c.Source} {c.PlcHost}:{c.PlcPort}, site {c.Site}/{c.Device}");
            SettingsMsg.Text = "Đã lưu. Ứng dụng sẽ chạy lại…";
            var psi = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false };
            foreach (var a in Environment.GetCommandLineArgs().Skip(1)) psi.ArgumentList.Add(a);
            Process.Start(psi);
            Application.Current.Shutdown();
        }
        catch (Exception ex) when (ex is FormatException or OverflowException) { SettingsMsg.Text = "Giá trị không hợp lệ: " + ex.Message; }
    }

    // ------------------------------------------------------------------ quản lý người dùng (chỉ Admin)
    void RefreshUsers()
    {
        var keep = (UserGrid.SelectedItem as UserRow)?.Name;
        var rows = _session.Store.List()
            .Select(u => new UserRow(u.Name, Roles.Display(u.Role), u.Disabled ? "Đã khoá" : "Hoạt động", u.Created.ToString("dd/MM/yyyy HH:mm"), u)).ToList();
        UserGrid.ItemsSource = rows;
        UserGrid.SelectedItem = rows.FirstOrDefault(r => r.Name == keep);
        OnUserSelected(UserGrid, null!);
    }

    void OnUserSelected(object s, SelectionChangedEventArgs e)
    {
        var u = (UserGrid.SelectedItem as UserRow)?.Raw;
        var any = u != null;
        SelTitle.Text = any ? $"Tài khoản: {u!.Name}" : "Chọn một tài khoản ở bảng trên";
        foreach (var c in new Control[] { EditRole, BApplyRole, EditPass, BSetPass, BToggle, BDelete }) c.IsEnabled = any;
        if (any) EditRole.SelectedIndex = (int)u!.Role;
    }

    UserRecord? Selected => (UserGrid.SelectedItem as UserRow)?.Raw;

    void Done(string? err, string okMsg, string audit)
    {
        UserMsg.Foreground = Res(err == null ? "Green" : "Orange");
        UserMsg.Text = err ?? okMsg;
        if (err == null) _session.Audit.Write(_session.Actor, "quản lý người dùng", audit);
        RefreshUsers();
    }

    void OnAddUser(object s, RoutedEventArgs e)
    {
        if (!Need(Permission.ManageUsers)) return;
        var role = (Role)((ComboBoxItem)NewRole.SelectedItem).Tag;
        var name = NewName.Text.Trim();
        var err = _session.Store.Create(name, NewPass.Password, role);
        if (err == null) { NewName.Clear(); NewPass.Clear(); }
        Done(err, $"Đã thêm {name}.", $"thêm {name} ({Roles.Display(role)})");
    }

    void OnApplyRole(object s, RoutedEventArgs e)
    {
        if (!Need(Permission.ManageUsers) || Selected is not { } u) return;
        if (u.Name.Equals(_session.Actor, StringComparison.OrdinalIgnoreCase)) { Done("Không tự đổi vai trò của chính mình.", "", ""); return; }
        var role = (Role)((ComboBoxItem)EditRole.SelectedItem).Tag;
        Done(_session.Store.SetRole(u.Name, role), $"Đã đổi vai trò của {u.Name}.", $"đổi vai trò {u.Name} → {Roles.Display(role)}");
    }

    void OnSetPassword(object s, RoutedEventArgs e)
    {
        if (!Need(Permission.ManageUsers) || Selected is not { } u) return;
        var err = _session.Store.SetPassword(u.Name, EditPass.Password);
        if (err == null) EditPass.Clear();
        Done(err, $"Đã đặt mật khẩu mới cho {u.Name}.", $"đặt lại mật khẩu {u.Name}");
    }

    void OnToggleDisabled(object s, RoutedEventArgs e)
    {
        if (!Need(Permission.ManageUsers) || Selected is not { } u) return;
        if (u.Name.Equals(_session.Actor, StringComparison.OrdinalIgnoreCase)) { Done("Không tự khoá chính mình.", "", ""); return; }
        Done(_session.Store.SetDisabled(u.Name, !u.Disabled), u.Disabled ? $"Đã mở khoá {u.Name}." : $"Đã khoá {u.Name}.", (u.Disabled ? "mở khoá " : "khoá ") + u.Name);
    }

    void OnDeleteUser(object s, RoutedEventArgs e)
    {
        if (!Need(Permission.ManageUsers) || Selected is not { } u) return;
        if (u.Name.Equals(_session.Actor, StringComparison.OrdinalIgnoreCase)) { Done("Không thể xoá tài khoản đang đăng nhập.", "", ""); return; }
        if (!Dialogs.Confirm(this, $"Xoá tài khoản \"{u.Name}\"? Không hoàn tác được.", "Xoá")) return;
        Done(_session.Store.Delete(u.Name), $"Đã xoá {u.Name}.", $"xoá {u.Name}");
    }
}
