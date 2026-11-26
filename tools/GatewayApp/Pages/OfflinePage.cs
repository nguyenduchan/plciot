using System.Globalization;
using GatewayApp.Ui;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Trang "Khi mất mạng" của board Waveshare (chỉ có trong cửa sổ thiết lập board — RemoteForm, kind "mcu"): mỗi DO chọn MỘT mẫu
/// (giữ nguyên / tắt / bật / lịch giờ / theo DI / ngưỡng có trễ / chạy-nghỉ chu kỳ) + vài con số. Không viết code, không có trên webapp:
/// kỹ thuật viên cài tại chỗ (LAN), sau này GatewayAdmin cài từ xa qua cùng API (/api/offline).
/// Nút "Thử mất mạng 2 phút": board chạy logic ngay để xem đúng chưa trước khi rời trạm.
/// </summary>
sealed class OfflinePage : UserControl
{
    static readonly (string Id, string Name)[] Modes =
    {
        ("hold", "Giữ nguyên"), ("off", "Tắt"), ("on", "Bật"), ("schedule", "Theo lịch giờ"),
        ("follow", "Theo DI"), ("threshold", "Theo ngưỡng giá trị"), ("cycle", "Chạy / nghỉ theo chu kỳ"),
    };

    readonly IGatewayApp _app;
    readonly Func<RemoteClient> _client;
    readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Top, Height = 30, Font = Theme.Semi, ForeColor = Theme.Text, Padding = new Padding(2, 6, 2, 0) };
    readonly FlatButton _save = new() { Caption = "💾 Lưu xuống board", Width = 170, Primary = true };
    readonly FlatButton _reload = new() { Caption = "↻ Tải lại", Width = 100 };
    readonly FlatButton _test = new() { Caption = "🧪 Thử mất mạng 2 phút", Width = 210 };
    readonly NumericUpDown _tz = new() { Minimum = -12, Maximum = 14, DecimalPlaces = 1, Increment = 0.5m, Value = 7, Width = 70 };
    readonly FlowLayoutPanel _list = new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = Theme.Bg };
    readonly Row[] _rows = new Row[8];
    readonly System.Windows.Forms.Timer _poll = new() { Interval = 2000 };
    ApiOffline _cur = new();
    bool _filling, _dirty, _busy, _loaded;
    long _testSec;

    /// <summary>Các ô của một chân DO. Chỉ nhóm ô của mẫu đang chọn được hiện.</summary>
    sealed class Row
    {
        public int Ch;
        public readonly Label Name = new() { AutoSize = false, Width = 230, Height = 26, Font = Theme.Semi, ForeColor = Theme.Text, Margin = new Padding(0, 6, 6, 0), UseMnemonic = false };
        public readonly ComboBox Mode = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, Margin = new Padding(0, 3, 8, 0) };
        public readonly NumericUpDown Delay = new() { Minimum = 0, Maximum = 86400, Increment = 30, Width = 80, Margin = new Padding(0, 3, 4, 0) };
        public readonly FlowLayoutPanel DelayBox = new() { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        public readonly FlowLayoutPanel PSched = Group(), PFollow = Group(), PThr = Group(), PCycle = Group();
        public readonly TextBox From = new() { Width = 60, Margin = new Padding(0, 3, 6, 0) }, To = new() { Width = 60, Margin = new Padding(0, 3, 6, 0) };
        public readonly ComboBox Di = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 190, Margin = new Padding(0, 3, 8, 0) };
        public readonly CheckBox Inv = new() { Text = "Ngược (DI có → tắt)", AutoSize = true, ForeColor = Theme.Text, Margin = new Padding(0, 6, 0, 0) };
        public readonly ComboBox Field = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220, Margin = new Padding(0, 3, 8, 0) };
        public readonly NumericUpDown On = Num(), Off = Num();
        public readonly NumericUpDown Age = new() { Minimum = 1, Maximum = 86400, Value = 30, Width = 70, Margin = new Padding(0, 3, 4, 0) };
        /// <summary>Nhãn ngưỡng tự đổi chiều theo thứ tự hai số: On &lt; Off → "bật khi ≤ / tắt khi ≥" (bơm cấp), ngược lại "≥ / ≤" (quạt).</summary>
        public readonly Label LOn = new() { AutoSize = true, ForeColor = Theme.Text, Margin = new Padding(0, 7, 6, 0) }, LOff = new() { AutoSize = true, ForeColor = Theme.Text, Margin = new Padding(0, 7, 6, 0) };
        public readonly NumericUpDown OnMin = Min(), OffMin = Min();
        public readonly Label State = new() { AutoSize = false, Height = 20, Width = 840, ForeColor = Theme.Muted, Font = Theme.Small, Margin = new Padding(236, 0, 0, 8), UseMnemonic = false };
        public readonly List<string> FieldKeys = new();

        static FlowLayoutPanel Group() => new() { AutoSize = true, WrapContents = false, Margin = new Padding(0), Visible = false };
        static NumericUpDown Num() => new() { Minimum = -1000000, Maximum = 1000000, DecimalPlaces = 2, Width = 80, Margin = new Padding(0, 3, 8, 0) };
        static NumericUpDown Min() => new() { Minimum = 0.1m, Maximum = 1440, DecimalPlaces = 1, Increment = 1, Value = 10, Width = 70, Margin = new Padding(0, 3, 6, 0) };
        public string ModeId => Modes[Math.Max(0, Mode.SelectedIndex)].Id;
    }

    public OfflinePage(IGatewayApp app, Func<RemoteClient> client)
    {
        _app = app; _client = client;
        BackColor = Theme.Bg; Padding = new Padding(18, 8, 18, 14);

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Theme.Bg, Padding = new Padding(0, 4, 0, 6), WrapContents = false };
        bar.Controls.Add(_save); bar.Controls.Add(_reload); bar.Controls.Add(_test);
        bar.Controls.Add(new Label { Text = "Múi giờ cho lịch: UTC +", AutoSize = true, ForeColor = Theme.Text, Margin = new Padding(24, 10, 4, 0) });
        Skin.Input(_tz); _tz.Margin = new Padding(0, 6, 0, 0); bar.Controls.Add(_tz);
        _save.Click += async (_, _) => await SaveAsync();
        _reload.Click += async (_, _) => { if (!_dirty || Ask("Bỏ các thay đổi chưa lưu?")) await LoadAsync(); };
        _test.Click += async (_, _) => await TestAsync();
        _tz.ValueChanged += (_, _) => Changed();

        var help = new Label
        {
            AutoSize = false, Dock = DockStyle.Top, Height = 58, ForeColor = Theme.Muted, Font = Theme.Small, Padding = new Padding(2, 2, 2, 0),
            Text = "Mất mạng = board không nối được cloud (hoặc mất PC đang giữ lease) liên tục quá \"sau … giây\" của từng chân. " +
                   "Có mạng lại: logic dừng, DO GIỮ trạng thái đang có (người vận hành quyết định tiếp). Người tại chỗ đổi DO tay thì logic nhường chân đó. " +
                   "Lịch giờ cần board có giờ (NTP/RTC) — không có giờ thì tắt; ngưỡng mất số liệu thì tắt. Thời gian tối thiểu bật/tắt và chế độ an toàn vẫn được tôn trọng.",
        };

        for (var i = 0; i < 8; i++) _rows[i] = BuildRow(i + 1);
        var card = new Card { Title = "Khi mất mạng — từng đầu ra (DO) của board", Sub = "Chọn một kiểu cho mỗi chân · lưu xuống board · bấm Thử để kiểm tra", Dock = DockStyle.Fill, Padding = new Padding(10, 44, 4, 4) };
        card.Controls.Add(_list);
        Controls.Add(card); Controls.Add(help); Controls.Add(_status); Controls.Add(bar);

        _poll.Tick += async (_, _) => await PollAsync();
        VisibleChanged += async (_, _) =>
        {
            if (!Visible) { _poll.Stop(); return; }
            RefreshNames();
            if (!_loaded || !_dirty) await LoadAsync();
            _poll.Start();
        };
        Disposed += (_, _) => { _poll.Stop(); _poll.Dispose(); };
    }

    Row BuildRow(int ch)
    {
        var r = new Row { Ch = ch };
        foreach (var m in Modes) r.Mode.Items.Add(m.Name);
        r.Mode.SelectedIndex = 0;
        foreach (var c in new Control[] { r.Mode, r.Delay, r.From, r.To, r.Di, r.Field, r.On, r.Off, r.Age, r.OnMin, r.OffMin }) Skin.Input(c);
        r.DelayBox.Controls.Add(L("sau")); r.DelayBox.Controls.Add(r.Delay); r.DelayBox.Controls.Add(L("giây mất mạng", 12));
        r.PSched.Controls.AddRange(new Control[] { L("bật lúc"), r.From, L("tắt lúc"), r.To, new Label { Text = "(HH:MM, qua đêm được)", AutoSize = true, ForeColor = Theme.Muted, Font = Theme.Small, Margin = new Padding(0, 8, 0, 0) } });
        for (var d = 1; d <= 8; d++) r.Di.Items.Add($"DI{d}");
        r.Di.SelectedIndex = 0;
        r.PFollow.Controls.AddRange(new Control[] { L("theo"), r.Di, r.Inv });
        r.PThr.Controls.AddRange(new Control[] { L("giá trị"), r.Field, r.LOn, r.On, r.LOff, r.Off, L("mất số liệu quá"), r.Age, L("giây → tắt") });
        r.PCycle.Controls.AddRange(new Control[] { L("bật"), r.OnMin, L("phút, nghỉ"), r.OffMin, L("phút, lặp lại") });

        // dòng 1: tên chân · kiểu · thời gian chờ; dòng 2 (thụt thẳng ô kiểu): tham số của mẫu đang chọn; dòng 3: trạng thái đang chạy
        var line = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0), BackColor = Theme.Bg };
        line.Controls.AddRange(new Control[] { r.Name, r.Mode, r.DelayBox });
        var pars = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(236, 0, 0, 0), BackColor = Theme.Bg };
        pars.Controls.AddRange(new Control[] { r.PSched, r.PFollow, r.PThr, r.PCycle });
        var box = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = new Padding(0, 0, 0, 2), BackColor = Theme.Bg };
        box.Controls.Add(line); box.Controls.Add(pars); box.Controls.Add(r.State);
        _list.Controls.Add(box);

        r.Mode.SelectedIndexChanged += (_, _) => { ShowParams(r); Changed(); };
        foreach (var c in new Control[] { r.Delay, r.On, r.Off, r.Age, r.OnMin, r.OffMin }) ((NumericUpDown)c).ValueChanged += (_, _) => { UpdateHint(r); Changed(); };
        r.From.TextChanged += (_, _) => Changed(); r.To.TextChanged += (_, _) => Changed();
        r.Di.SelectedIndexChanged += (_, _) => Changed(); r.Field.SelectedIndexChanged += (_, _) => Changed();
        r.Inv.CheckedChanged += (_, _) => Changed();
        ShowParams(r);
        return r;
    }

    static Label L(string t, int right = 6) => new() { Text = t, AutoSize = true, ForeColor = Theme.Text, Margin = new Padding(0, 7, right, 0) };

    void ShowParams(Row r)
    {
        var m = r.ModeId;
        r.DelayBox.Visible = m != "hold";
        r.PSched.Visible = m == "schedule"; r.PFollow.Visible = m == "follow"; r.PThr.Visible = m == "threshold"; r.PCycle.Visible = m == "cycle";
        UpdateHint(r);
    }

    static void UpdateHint(Row r)
    {
        var up = r.On.Value <= r.Off.Value;   // bật ở ngưỡng thấp (bơm cấp nước) hay ở ngưỡng cao (quạt theo nhiệt)
        r.LOn.Text = up ? "bật khi ≤" : "bật khi ≥"; r.LOff.Text = up ? "tắt khi ≥" : "tắt khi ≤";
        r.LOn.ForeColor = r.LOff.ForeColor = r.On.Value == r.Off.Value ? Theme.Red : Theme.Text;   // hai ngưỡng bằng nhau: không có khoảng trễ
    }

    void Changed() { if (!_filling) { _dirty = true; _save.Caption = "💾 Lưu xuống board *"; } }

    static bool Ask(string q) => MessageBox.Show(q, "Khi mất mạng", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;

    // ------------------------------------------------------------------ tên chân / danh sách field từ cấu hình board
    static bool LocalIo(PackMap p) => p.Source == PlcSource.ModbusRtu && p.Param("unit") == "0";

    void RefreshNames()
    {
        var pack = _app.Config.Pack;
        string Title(string child) => _app.Meta.Device(child)?.Title is { Length: > 0 } t ? t : child;
        string? Pin(int addr, bool write) => pack.Where(p => LocalIo(p) && p.Address == addr && (p.Access != PackAccess.Read) == write).Select(p => Title(p.Child)).FirstOrDefault();
        var fields = pack.Where(p => p.Access != PackAccess.Write).Select(p => (Key: $"{p.Child}.{p.Field}", Text: $"{Title(p.Child)} · {(_app.Meta.Get(p.Child, p.Field)?.Title is { Length: > 0 } ft ? ft : p.Field)}")).ToList();
        _filling = true;
        foreach (var r in _rows)
        {
            r.Name.Text = $"DO{r.Ch} · {Pin(20 + r.Ch - 1, true) ?? "(chưa nối thiết bị)"}";
            var di = r.Di.SelectedIndex;
            r.Di.Items.Clear();
            for (var d = 1; d <= 8; d++) r.Di.Items.Add(Pin(10 + d - 1, false) is { } n ? $"DI{d} · {n}" : $"DI{d}");
            r.Di.SelectedIndex = Math.Max(0, di);
            var keep = r.Field.SelectedIndex >= 0 && r.Field.SelectedIndex < r.FieldKeys.Count ? r.FieldKeys[r.Field.SelectedIndex] : null;
            r.Field.Items.Clear(); r.FieldKeys.Clear();
            foreach (var f in fields) { r.Field.Items.Add(f.Text); r.FieldKeys.Add(f.Key); }
            SelectField(r, keep);
        }
        _filling = false;
    }

    static void SelectField(Row r, string? key)
    {
        if (key == null) { r.Field.SelectedIndex = r.Field.Items.Count > 0 ? 0 : -1; return; }
        var i = r.FieldKeys.IndexOf(key);
        if (i < 0) { r.Field.Items.Add(key + " (không còn trong cấu hình)"); r.FieldKeys.Add(key); i = r.FieldKeys.Count - 1; }
        r.Field.SelectedIndex = i;
    }

    // ------------------------------------------------------------------ đọc / ghi board
    async Task LoadAsync()
    {
        try { Fill(await _client().OfflineAsync()); _loaded = true; }
        catch (Exception e) { _status.Text = "Không đọc được cài đặt từ board: " + RemoteClient.Explain(e); _status.ForeColor = Theme.Red; }
    }

    void Fill(ApiOffline p)
    {
        _cur = p;
        _filling = true;
        _tz.Value = Math.Clamp(p.TzMin / 60m, _tz.Minimum, _tz.Maximum);
        foreach (var r in _rows)
        {
            var rule = p.Do.FirstOrDefault(x => x.Ch == r.Ch);
            if (rule == null && p.Legacy?.FirstOrDefault(x => x.Ch == r.Ch) is { } lg)   // cài đặt cũ "tắt sau N giây" (hộp thoại thiết bị) → hiện thành "Tắt", lưu là chuyển hẳn sang đây
                rule = new OfflineRule { Ch = r.Ch, Mode = "off", DelaySec = lg.DelaySec };
            rule ??= new OfflineRule { Ch = r.Ch };
            r.Mode.SelectedIndex = Math.Max(0, Array.FindIndex(Modes, m => m.Id == rule.Mode));
            r.Delay.Value = Math.Clamp(rule.DelaySec, 0, 86400);
            r.From.Text = rule.From ?? "18:00"; r.To.Text = rule.To ?? "06:00";
            r.Di.SelectedIndex = Math.Clamp((rule.Di ?? 1) - 1, 0, 7); r.Inv.Checked = rule.Invert ?? false;
            SelectField(r, rule.Field);
            r.On.Value = (decimal)Math.Clamp(rule.On ?? 20, -1000000, 1000000); r.Off.Value = (decimal)Math.Clamp(rule.Off ?? 80, -1000000, 1000000);
            r.Age.Value = Math.Clamp(rule.MaxAgeSec ?? 30, 1, 86400);
            r.OnMin.Value = Math.Clamp((rule.OnSec ?? 600) / 60m, r.OnMin.Minimum, r.OnMin.Maximum);
            r.OffMin.Value = Math.Clamp((rule.OffSec ?? 600) / 60m, r.OffMin.Minimum, r.OffMin.Maximum);
            ShowParams(r);
        }
        _filling = false; _dirty = false; _save.Caption = "💾 Lưu xuống board";
        ShowStatus(p.Status);
    }

    /// <summary>Gom các ô thành chính sách. Lưu ĐỦ 8 chân (kể cả "giữ nguyên") → cài đặt cũ LossOffSec không còn chen vào.</summary>
    ApiOffline? Collect(out string err)
    {
        err = "";
        var o = new ApiOffline { Rev = _cur.Rev, TzMin = (int)Math.Round(_tz.Value * 60) };
        foreach (var r in _rows)
        {
            var x = new OfflineRule { Ch = r.Ch, Mode = r.ModeId, DelaySec = (int)r.Delay.Value };
            // trang này chỉ sửa phần "khi mất mạng": giữ nguyên chặn lệnh + hẹn giờ của chương trình (sửa bằng GatewayAdmin / webapp)
            if (_cur.Do.FirstOrDefault(d => d.Ch == r.Ch) is { } old)
            { x.Need = old.Need; x.NeedHold = old.NeedHold; x.Block = old.Block; x.MaxOnSec = old.MaxOnSec; x.Timer = old.Timer; }
            switch (x.Mode)
            {
                case "schedule":
                    if (!TimeOnly.TryParseExact(r.From.Text.Trim(), "H:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var a) ||
                        !TimeOnly.TryParseExact(r.To.Text.Trim(), "H:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var b)) { err = $"DO{r.Ch}: giờ bật/tắt phải dạng HH:MM (vd. 18:00)."; return null; }
                    if (a == b) { err = $"DO{r.Ch}: giờ bật và giờ tắt phải khác nhau."; return null; }
                    x.From = a.ToString("HH:mm"); x.To = b.ToString("HH:mm");
                    break;
                case "follow": x.Di = r.Di.SelectedIndex + 1; x.Invert = r.Inv.Checked; break;
                case "threshold":
                    if (r.Field.SelectedIndex < 0) { err = $"DO{r.Ch}: chưa có giá trị nào để theo dõi (thêm thiết bị đọc cảm biến trước)."; return null; }
                    if (r.On.Value == r.Off.Value) { err = $"DO{r.Ch}: ngưỡng bật và ngưỡng tắt phải khác nhau."; return null; }
                    x.Field = r.FieldKeys[r.Field.SelectedIndex]; x.On = (double)r.On.Value; x.Off = (double)r.Off.Value; x.MaxAgeSec = (int)r.Age.Value;
                    break;
                case "cycle": x.OnSec = (int)Math.Round(r.OnMin.Value * 60); x.OffSec = (int)Math.Round(r.OffMin.Value * 60); break;
            }
            o.Do.Add(x);
        }
        return o;
    }

    async Task SaveAsync()
    {
        if (_busy || !_app.RequireEdit()) return;
        var p = Collect(out var err);
        if (p == null) { _app.Toast(err, error: true); return; }
        _busy = true;
        try
        {
            var r = await _client().PutOfflineAsync(p);
            _app.Toast($"Đã lưu logic khi mất mạng xuống board (bản {r.Rev}).");
            await LoadAsync();
        }
        catch (RemoteException e) when (e.Code == "rev_conflict") { _app.Toast(RemoteClient.Explain(e), error: true); await LoadAsync(); }
        catch (Exception e) { _app.Toast("Chưa lưu được: " + RemoteClient.Explain(e), error: true); }
        finally { _busy = false; }
    }

    async Task TestAsync()
    {
        if (_busy || !_app.RequireEdit()) return;
        var stop = _testSec > 0;
        if (!stop && _dirty) { _app.Toast("Có thay đổi chưa lưu — bấm \"Lưu xuống board\" trước, thử sẽ chạy theo bản đã lưu.", error: true); return; }
        if (!stop && !Ask("Board sẽ coi như MẤT MẠNG trong 2 phút: các DO có cài đặt sẽ đổi trạng thái THẬT ngay (bỏ qua thời gian chờ).\n\nTiếp tục?")) return;
        _busy = true;
        try { await _client().OfflineTestAsync(stop ? 0 : 120); await PollAsync(); }
        catch (Exception e) { _app.Toast(RemoteClient.Explain(e), error: true); }
        finally { _busy = false; }
    }

    async Task PollAsync()
    {
        if (!Visible || _busy) return;
        try
        {
            var p = await _client().OfflineAsync();
            if (!_dirty && p.Rev != _cur.Rev) { Fill(p); return; }   // người khác vừa sửa (và mình chưa sửa gì): hiện bản mới
            ShowStatus(p.Status);
        }
        catch (Exception) { /* mất kết nối LAN: RemoteForm đã báo */ }
    }

    void ShowStatus(OfflineStatus? s)
    {
        if (s == null) return;
        _testSec = s.TestSec;
        _test.Caption = s.TestSec > 0 ? "■ Dừng thử" : "🧪 Thử mất mạng 2 phút";
        var time = s.TimeOk ? "board có giờ" : "board CHƯA có giờ (lịch giờ sẽ tắt)";
        (_status.Text, _status.ForeColor) =
            s.TestSec > 0 ? ($"ĐANG THỬ MẤT MẠNG — còn {s.TestSec} giây · {time}", Theme.Yellow)
            : s.Down ? ($"MẤT MẠNG {Dur(s.DownSec)} — logic đang chạy · {time}", Theme.Yellow)
            : !s.Expected ? ($"Board chạy LAN, chưa nối cloud — không có \"mất mạng\" (chỉ chạy khi bấm Thử) · {time}", Theme.Muted)
            : ($"Đang có mạng — logic chờ sẵn · {time}", Theme.Green);
        foreach (var c in s.Ch)
        {
            if (c.Ch < 1 || c.Ch > 8) continue;
            var r = _rows[c.Ch - 1];
            var now = c.Out != 0 ? "đang BẬT" : "đang tắt";
            r.State.Text = c.Manual ? $"{now} · đã đổi tay — logic nhường tới khi có mạng lại"
                : c.Active ? $"{now} · ▶ {c.Text}" + (c.Note.Length > 0 ? $" — {c.Note}" : "")
                : c.Mode == "hold" ? $"{now} · mất mạng: giữ nguyên"
                : $"{now} · mất mạng: {c.Text}" + (c.Note.Length > 0 ? $" ({c.Note})" : "");
            r.State.ForeColor = c.Active ? Theme.Yellow : Theme.Muted;
        }
    }

    static string Dur(long sec) => sec < 120 ? $"{sec} giây" : sec < 7200 ? $"{sec / 60} phút" : $"{sec / 3600} giờ {sec % 3600 / 60} phút";

    /// <summary>Kiểm thử (--offlinetest): đặt chính sách bằng đúng các ô của trang rồi bấm Lưu.</summary>
    internal async Task<string?> SetForTestAsync(Action<Func<int, (ComboBox Mode, NumericUpDown Delay, TextBox From, TextBox To, ComboBox Di, CheckBox Inv, ComboBox Field, NumericUpDown On, NumericUpDown Off, NumericUpDown OnMin, NumericUpDown OffMin)>> set)
    {
        set(ch => { var r = _rows[ch - 1]; return (r.Mode, r.Delay, r.From, r.To, r.Di, r.Inv, r.Field, r.On, r.Off, r.OnMin, r.OffMin); });
        var p = Collect(out var err);
        if (p == null) return err;
        try { await _client().PutOfflineAsync(p); await LoadAsync(); return null; }
        catch (Exception e) { return RemoteClient.Explain(e); }
    }
    internal static int ModeIndex(string id) => Array.FindIndex(Modes, m => m.Id == id);
    internal string StatusText => _status.Text;
    internal string RowState(int ch) => _rows[ch - 1].State.Text;
    internal Task TestForTestAsync(int sec) => _client().OfflineTestAsync(sec);
    internal Task RefreshForTestAsync() => PollAsync();
}
