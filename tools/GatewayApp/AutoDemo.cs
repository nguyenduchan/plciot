using System.Net.Sockets;
using System.Reflection;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Chế độ trình diễn (--autodemo): chương trình tự "bấm chuột, gõ phím, kéo thanh trượt" thật trên giao diện, chậm để quan sát.
/// Chờ PlcSim mở cổng Modbus TCP, thêm thiết bị bồn nước (mực nước) và bơm (chỉ giữ tốc độ), chạy gateway rồi kéo thanh trượt tốc độ bơm.
/// Mọi thao tác đi qua đúng hộp thoại, nút và thanh trượt của người dùng (kéo thanh trượt gửi lệnh qua ScadaCore.ExecuteKeyAsync).
/// </summary>
public sealed partial class MainForm
{
    Label? _banner;

    async Task Say(string text, int ms = 1800)
    {
        if (_banner != null) _banner.Text = text;
        if (Environment.GetEnvironmentVariable("AUTODEMO_LOG") is { Length: > 0 } lf) { try { File.AppendAllText(lf, $"{DateTime.Now:HH:mm:ss} [gateway] {text}{Environment.NewLine}"); } catch (IOException) { } }
        await Task.Delay(ms);
    }

    async Task TypeAsync(Control c, string text, int perChar = 110)
    {
        c.Focus();
        if (c is TextBox or ComboBox) { c.Text = ""; await Task.Delay(300); }
        foreach (var ch in text) { c.Text += ch; await Task.Delay(perChar); }
        await Task.Delay(500);
    }

    async Task PickAsync(ComboBox cb, int index)
    {
        cb.Focus(); await Task.Delay(500);
        cb.DroppedDown = true; await Task.Delay(900);
        cb.SelectedIndex = index; await Task.Delay(500);
        cb.DroppedDown = false; await Task.Delay(400);
    }

    async Task MoveCursorAsync(Point target)
    {
        var start = Cursor.Position;
        for (var i = 1; i <= 25; i++)
        {
            Cursor.Position = new Point(start.X + (target.X - start.X) * i / 25, start.Y + (target.Y - start.Y) * i / 25);
            await Task.Delay(18);
        }
    }

    /// <summary>Di chuyển con trỏ thật tới giữa control rồi bấm. blocking=false khi nút mở hộp thoại modal.</summary>
    async Task ClickAsync(Control c, bool blocking = true)
    {
        await MoveCursorAsync(c.PointToScreen(new Point(c.Width / 2, c.Height / 2)));
        await Task.Delay(450);
        var onClick = typeof(Control).GetMethod("OnClick", NP)!;
        if (blocking) onClick.Invoke(c, new object[] { EventArgs.Empty });
        else BeginInvoke(() => onClick.Invoke(c, new object[] { EventArgs.Empty }));
        await Task.Delay(500);
    }

    static List<T> FindAll<T>(Control root) where T : Control
    {
        var r = new List<T>();
        foreach (Control c in root.Controls) { if (c is T t) r.Add(t); r.AddRange(FindAll<T>(c)); }
        return r;
    }

    static async Task<bool> PortOpenAsync(int port)
    {
        try { using var t = new TcpClient(); await t.ConnectAsync("127.0.0.1", port).WaitAsync(TimeSpan.FromSeconds(1)); return true; }
        catch (Exception) { return false; }
    }

    /// <summary>Đặt con trỏ + kéo thanh trượt thật (gửi sự kiện chuột vào chính control) tới giá trị mới.</summary>
    async Task DragSliderAsync(SliderBar sl, double target)
    {
        int X(double v) => (int)(10 + (v - sl.Min) / (sl.Max - sl.Min) * (sl.Width - 20));
        int y = sl.Height / 2, x0 = X(sl.Value), x1 = X(target);
        await MoveCursorAsync(sl.PointToScreen(new Point(x0, y)));
        await Task.Delay(500);
        void Mouse(string method, int x) => typeof(Control).GetMethod(method, NP)!.Invoke(sl, new object[] { new MouseEventArgs(MouseButtons.Left, 1, x, y, 0) });
        Mouse("OnMouseDown", x0);
        for (var i = 1; i <= 30; i++)
        {
            var x = x0 + (x1 - x0) * i / 30;
            Cursor.Position = sl.PointToScreen(new Point(x, y));
            Mouse("OnMouseMove", x);
            await Task.Delay(45);
        }
        await Task.Delay(400);
        Mouse("OnMouseUp", x1);     // thả chuột → gửi lệnh
        await Task.Delay(300);
    }

    async Task RunDialogAsync(Func<Form, Task> script, Control opener)
    {
        var done = new TaskCompletionSource();
        DeviceDialog.Hook = async d => { try { await script(d); } finally { done.TrySetResult(); } };
        await ClickAsync(opener, blocking: false);
        await done.Task;
        DeviceDialog.Hook = null;
        await Task.Delay(800);
    }

    async Task ShowCellsAsync(DataGridView g, DataGridViewRow row, params (int Col, string Note)[] cells)
    {
        foreach (var (col, note) in cells)
        {
            g.CurrentCell = row.Cells[col];
            await Say(note, 1700);
        }
    }

    async Task ConnectionAsync(Form d)
    {
        await Say("Giao thức: Modbus TCP — khai báo kết nối tới PLC");
        await PickAsync(F<ComboBox>(d, "_proto"), 0);
        var conn = F<Dictionary<string, Control>>(d, "_connInputs");
        await Say("Địa chỉ PLC (máy chạy PlcSim): 127.0.0.1");
        await TypeAsync(conn["host"], "127.0.0.1");
        await Say("Cổng Modbus TCP: 502");
        await TypeAsync(conn["port"], "502");
        await Say("Thông số riêng của Modbus TCP: Unit ID (slave) = 1");
        await TypeAsync(F<Dictionary<string, Control>>(d, "_paramInputs")["unit"], "1");
    }

    public async Task AutoDemoAsync()
    {
        var wa = Screen.FromControl(this).WorkingArea;
        StartPosition = FormStartPosition.Manual; WindowState = FormWindowState.Normal;
        var w = Math.Max(Math.Min(MinimumSize.Width, wa.Width), (int)(wa.Width * 0.58));
        Bounds = new Rectangle(wa.Right - w, wa.Top, w, wa.Height);
        _banner = new Label
        {
            Dock = DockStyle.Bottom, Height = 54, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 14, 0),
            BackColor = Color.FromArgb(18, 120, 90), ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 12f),
        };
        Controls.Add(_banner); Controls.SetChildIndex(_banner, Controls.Count - 1);

        while (!await PortOpenAsync(502)) await Say("Gateway: chờ PlcSim mở cổng Modbus TCP 502 (xem cửa sổ PlcSim bên trái)…", 1500);
        Activate();
        await Say("Gateway: danh sách thiết bị RỖNG. Sẽ thêm bồn nước (mực nước) và bơm (điều khiển tốc độ).", 3500);

        // ---- trang Thiết bị
        await Say("Mở trang Thiết bị…", 800);
        await ClickAsync(_pages[1].Btn);
        var addBtn = F<FlatButton>(_devices, "_addBtn");

        // ---- thiết bị 1: bồn nước
        await Say("Bước 1/4: bấm ＋ Thêm thiết bị ngoại vi → chọn Bồn nước", 2200);
        await RunDialogAsync(async d =>
        {
            await Say("Chọn loại thiết bị vật lý: Bồn nước / cảm biến mức");
            await ClickAsync(FindAll<TemplateTile>(d).First(t => t.Tpl.Id == "tank"));
            await ConnectionAsync(d);
            var g = F<DataGridView>(d, "_g");
            await ShowCellsAsync(g, g.Rows[0],
                (0, "Field: level (mực nước)"), (2, "Quyền: Chỉ đọc — gateway chỉ giám sát, không ghi được"),
                (3, "Kiểu dữ liệu: UINT (1 word)"), (4, "Thanh ghi D50 (trùng luồng tank1.level trên PlcSim)"), (5, "Hệ số 10: D = mực × 10"));
            await Say("Bấm Thêm thiết bị", 1200);
            await ClickAsync(FindAll<FlatButton>(d).First(b => b.Caption == "Thêm thiết bị"));
        }, addBtn);

        // ---- thiết bị 2: bơm — chỉ giữ tốc độ
        await Say("Bước 2/4: thêm tiếp thiết bị Bơm; chỉ giữ field tốc độ (xoá run, flow, hours)", 2500);
        await RunDialogAsync(async d =>
        {
            await Say("Chọn loại thiết bị vật lý: Bơm");
            await ClickAsync(FindAll<TemplateTile>(d).First(t => t.Tpl.Id == "pump"));
            await Say("Kết nối Modbus TCP đã khai báo ở thiết bị trước — dùng chung", 2200);
            var g = F<DataGridView>(d, "_g");
            foreach (var name in new[] { "run", "flow", "hours" })
            {
                var row = g.Rows.Cast<DataGridViewRow>().First(r => Convert.ToString(r.Cells[0].Value) == name);
                g.CurrentCell = row.Cells[0];
                await Say($"Bỏ field \"{name}\" (không dùng trong demo)", 1500);
                g.Rows.Remove(row);
            }
            var speed = g.Rows.Cast<DataGridViewRow>().First(r => Convert.ToString(r.Cells[0].Value) == "speed");
            await ShowCellsAsync(g, speed,
                (0, "Field còn lại: speed (tốc độ bơm)"), (2, "Quyền: Đọc/ghi — gateway điều khiển được tốc độ"),
                (3, "Kiểu dữ liệu: UINT"), (4, "Thanh ghi D52 (trùng luồng pump1.speed trên PlcSim)"),
                (5, "Hệ số 10: D = tốc độ × 10"), (7, "Giới hạn ghi: 0 – 100 %"));
            await Say("Bấm Thêm thiết bị", 1200);
            await ClickAsync(FindAll<FlatButton>(d).First(b => b.Caption == "Thêm thiết bị"));
        }, addBtn);

        await Say("Bước 3/4: bấm ▶ Chạy gateway", 2000);
        await ClickAsync(_start);
        for (var i = 0; i < 40 && !(Running && _host!.Core.State.Status == "online"); i++) await Task.Delay(500);

        await Say("Mở trang Tổng quan: mực nước đọc từ PlcSim qua Modbus TCP.", 800);
        await ClickAsync(_pages[0].Btn);
        await Say("Mực nước dao động (PlcSim sinh sóng sin 20–80 %). Tốc độ bơm đang đọc từ PlcSim.", 5000);

        // ---- điều khiển tốc độ bơm bằng thanh trượt thật
        var slider = FindAll<SliderBar>(_dash).FirstOrDefault();
        if (slider == null) { await Say("Không thấy thanh trượt tốc độ bơm trên Tổng quan.", 3000); return; }
        foreach (var target in new[] { 60.0, 90.0, 25.0 })
        {
            await Say($"Bước 4/4: kéo thanh trượt tốc độ bơm tới {target} % rồi thả chuột → gateway ghi xuống PlcSim", 1500);
            await DragSliderAsync(slider, target);
            await Say($"Đã gửi pump1.speed = {target} % (xem cửa sổ PlcSim: dòng pump1.speed và banner “Nhận lệnh từ gateway”)", 5000);
        }
        await Say("Xong demo. Bạn có thể tự kéo thanh trượt hoặc thêm thiết bị; đóng cửa sổ để thoát.", 0);
    }
}
