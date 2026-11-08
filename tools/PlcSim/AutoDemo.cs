using System.Reflection;

namespace PlcSim;

/// <summary>
/// Chế độ trình diễn (--autodemo): chương trình tự "bấm chuột, gõ phím" thật trên giao diện, chậm để quan sát:
/// thêm luồng mực nước (tank1.level, chỉ đọc, sóng sin) và tốc độ bơm (pump1.speed, đọc/ghi), bấm Bắt đầu, rồi chờ lệnh từ gateway.
/// Mọi thao tác đi qua đúng hộp thoại và nút của người dùng, không gọi tắt vào model.
/// </summary>
public sealed partial class MainForm
{
    Label? _banner;

    async Task Say(string text, int ms = 1800)
    {
        if (_banner != null) _banner.Text = text;
        if (Environment.GetEnvironmentVariable("AUTODEMO_LOG") is { Length: > 0 } lf) { try { File.AppendAllText(lf, $"{DateTime.Now:HH:mm:ss} [plcsim] {text}{Environment.NewLine}"); } catch (IOException) { } }
        await Task.Delay(ms);
    }

    async Task TypeAsync(Control c, string text, int perChar = 110)
    {
        c.Focus();
        // gõ bằng bộ đệm riêng: ô số tự định dạng lại chữ ("1" → "1.000") nên không được đọc Text rồi nối thêm
        if (c is ComboBox or TextBox or NumericUpDown) { c.Text = ""; await Task.Delay(300); }
        var buf = "";
        foreach (var ch in text) { buf += ch; c.Text = buf; await Task.Delay(perChar); }
        if (c is NumericUpDown nu && decimal.TryParse(buf.Replace(',', '.'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var dv)) nu.Value = Math.Clamp(dv, nu.Minimum, nu.Maximum);
        await Task.Delay(500);
    }

    async Task PickAsync(ComboBox cb, int index)
    {
        cb.Focus(); await Task.Delay(500);
        cb.DroppedDown = true; await Task.Delay(900);
        cb.SelectedIndex = index; await Task.Delay(500);
        cb.DroppedDown = false; await Task.Delay(400);
    }

    /// <summary>Di chuyển con trỏ thật tới giữa control rồi bấm. blocking=false khi nút mở hộp thoại modal (không chờ hộp thoại đóng).</summary>
    async Task ClickAsync(Control c, bool blocking = true)
    {
        var target = c.PointToScreen(new Point(c.Width / 2, c.Height / 2));
        var start = Cursor.Position;
        for (var i = 1; i <= 25; i++)
        {
            Cursor.Position = new Point(start.X + (target.X - start.X) * i / 25, start.Y + (target.Y - start.Y) * i / 25);
            await Task.Delay(18);
        }
        await Task.Delay(450);
        var onClick = typeof(Control).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!;
        if (blocking) onClick.Invoke(c, new object[] { EventArgs.Empty });
        else BeginInvoke(() => onClick.Invoke(c, new object[] { EventArgs.Empty }));
        await Task.Delay(500);
    }

    static Button? FindButton(Control root, string text)
    {
        foreach (Control c in root.Controls)
        {
            if (c is Button b && b.Text == text) return b;
            if (FindButton(c, text) is { } x) return x;
        }
        return null;
    }

    /// <summary>Điền một luồng vào hộp thoại "Thêm luồng dữ liệu" từng bước như người dùng.</summary>
    async Task FillStreamAsync(StreamDialog d, string child, string field, int accessIdx, int addr, double scale, int modeIdx, string modeValues)
    {
        await Say($"Nhập tên thiết bị: {child}");
        await TypeAsync(F<ComboBox>(d, "_child"), child);
        await Say($"Nhập tên field: {field}");
        await TypeAsync(F<TextBox>(d, "_field"), field);
        await Say(accessIdx == 0 ? "Quyền truy cập: Chỉ đọc (PLC → gateway; gateway không ghi được)" : "Quyền truy cập: Đọc và ghi (gateway điều khiển được)");
        await PickAsync(F<ComboBox>(d, "_access"), accessIdx);
        await Say("Kiểu dữ liệu: UINT (16-bit không dấu, 1 word)");
        await PickAsync(F<ComboBox>(d, "_type"), 0);
        await Say("Giao thức: Modbus TCP");
        await PickAsync(F<ComboBox>(d, "_proto"), 0);
        await Say("Thông số riêng của Modbus TCP: Unit ID = 1");
        await TypeAsync(d.ParamControl("unit"), "1");
        await Say($"Thanh ghi D bắt đầu: D{addr}");
        await TypeAsync(F<NumericUpDown>(d, "_addr"), addr.ToString());
        await Say($"Hệ số: D = giá trị × {scale}");
        await TypeAsync(F<NumericUpDown>(d, "_scale"), scale.ToString(System.Globalization.CultureInfo.InvariantCulture));
        await Say("Cách sinh giá trị giả lập");
        await PickAsync(F<ComboBox>(d, "_mode"), modeIdx);
        if (modeIdx == 2)   // sóng sin: Min, Max, chu kỳ
        {
            await Say("Sóng sin: mực nước dao động từ 20 đến 80 %, chu kỳ 30 giây");
            await TypeAsync(F<NumericUpDown>(d, "_min"), "20");
            await TypeAsync(F<NumericUpDown>(d, "_max"), "80");
            await TypeAsync(F<NumericUpDown>(d, "_period"), "30");
        }
        else
        {
            await Say($"Giá trị cố định ban đầu: {modeValues}");
            await TypeAsync(F<NumericUpDown>(d, "_value"), modeValues);
        }
        await Say("Bấm Thêm để tạo luồng", 1200);
        await ClickAsync(FindButton(d.Window, "Thêm")!);
        for (var i = 0; i < 30 && d.Window.Visible; i++) await Task.Delay(100);
        if (d.Window.Visible) await Say("LỖI hộp thoại: " + F<Label>(d, "_err").Text, 5000);   // nếu dữ liệu sai thì hiện rõ, không bỏ qua
        await Task.Delay(800);
    }

    public async Task AutoDemoAsync()
    {
        var wa = Screen.FromControl(this).WorkingArea;
        StartPosition = FormStartPosition.Manual;
        WindowState = FormWindowState.Normal;
        Bounds = new Rectangle(wa.Left, wa.Top, (int)(wa.Width * 0.5), wa.Height);
        _banner = new Label
        {
            Dock = DockStyle.Top, Height = 54, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0),
            BackColor = Color.FromArgb(24, 90, 170), ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 12f),
        };
        Controls.Add(_banner); Controls.SetChildIndex(_banner, Controls.Count - 1);
        _model.Changed += (desc, origin) =>
        {
            if (origin != "gateway") return;
            try
            {
                BeginInvoke(() =>
                {
                    var v = _model.Fields().Where(f => f.Child == "pump1" && f.Field == "speed").Select(f => f.Value.ToString("0.##")).FirstOrDefault() ?? "(chưa có luồng)";
                    _banner.Text = $"◀ Nhận lệnh từ gateway: {desc}  →  pump1.speed hiện = {v}";
                    if (Environment.GetEnvironmentVariable("AUTODEMO_LOG") is { Length: > 0 } lf) File.AppendAllText(lf, $"{DateTime.Now:HH:mm:ss} [plcsim] {_banner.Text}{Environment.NewLine}");
                });
            }
            catch (InvalidOperationException) { }
        };
        Activate();

        await Say("PlcSim: bắt đầu với danh sách luồng RỖNG. Sẽ thêm 2 luồng: mực nước (chỉ đọc) và tốc độ bơm (đọc/ghi).", 3500);

        // ---- luồng 1: mực nước
        var done = new TaskCompletionSource();
        await Say("Bước 1/3: bấm ＋ Thêm luồng dữ liệu → mực nước tank1.level");
        _demoHook = async d => { try { await FillStreamAsync(d, "tank1", "level", 0, 50, 10, 2, ""); } finally { done.TrySetResult(); } };
        await ClickAsync(_addBtn, blocking: false);
        await done.Task;

        // ---- luồng 2: tốc độ bơm
        done = new TaskCompletionSource();
        await Say("Bước 2/3: thêm tiếp ＋ luồng tốc độ bơm pump1.speed (đọc/ghi: gateway điều khiển được)");
        _demoHook = async d => { try { await FillStreamAsync(d, "pump1", "speed", 2, 52, 10, 0, "30"); } finally { done.TrySetResult(); } };
        await ClickAsync(_addBtn, blocking: false);
        await done.Task;
        _demoHook = null;
        var summary = string.Join(", ", Streams().Select(x => $"{x.Child}.{x.Field}@D{x.Addr}x{x.Scale}/{AccessName(x.Access)}/{ModeName(_model.ModeOf(x.Child, x.Field).Mode)}"));
        await Say($"Luồng trong bảng: {summary}", 4000);

        await Say("Hai luồng đã có trong bảng. Bước 3/3: bấm ▶ Bắt đầu để mở máy chủ Modbus TCP (cổng 502).", 3000);
        await ClickAsync(_start);
        await Say("PlcSim đang chạy: mực nước dao động theo sóng sin. Chờ gateway nối vào và điều khiển tốc độ bơm…", 4000);
        if (_banner.Text.StartsWith("◀")) return;
        _banner.Text = "PlcSim đang chạy — đang chờ lệnh từ gateway…";
    }
}
