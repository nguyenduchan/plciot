using System.Globalization;
using System.Reflection;

namespace PlcSim;

/// <summary>Chạy thử không cần bấm tay: dùng đúng hộp thoại "Thêm luồng dữ liệu" (điền ô rồi bấm Thêm), chạy Modbus TCP, ghi kết quả ra file.</summary>
public sealed partial class MainForm
{
    static T F<T>(object o, string name) => (T)o.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(o)!;

    /// <summary>Thêm một luồng qua hộp thoại thật; trả về thông báo lỗi của hộp thoại (rỗng = thành công).</summary>
    string AddStreamViaDialog(string child, string field, int addr, double scale, int modeIndex, double value, double min, double max)
    {
        using var d = NewStreamDialog(null);
        F<ComboBox>(d, "_child").Text = child;
        F<TextBox>(d, "_field").Text = field;
        F<NumericUpDown>(d, "_addr").Value = addr;
        F<NumericUpDown>(d, "_scale").Value = (decimal)scale;
        F<ComboBox>(d, "_mode").SelectedIndex = modeIndex;
        F<NumericUpDown>(d, "_value").Value = (decimal)value;
        F<NumericUpDown>(d, "_min").Value = (decimal)min;
        F<NumericUpDown>(d, "_max").Value = (decimal)max;
        typeof(StreamDialog).GetMethod("Commit", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(d, null);
        var form = F<Form>(d, "_f");
        var err = F<Label>(d, "_err").Text;
        if (form.DialogResult != DialogResult.OK) return err.Length > 0 ? err : "hộp thoại không đóng với OK";
        ApplyStream(d);
        return "";
    }

    public async Task SelfTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        // mặc định phải rỗng
        log.Add($"empty_on_start={_model.Fields().Length == 0}");
        // chế độ: 0 cố định, 1 ngẫu nhiên, 2 sin, 3 tăng dần
        var steps = new (string C, string F, int A, double Sc, int M, double V, double Mn, double Mx)[]
        {
            ("dev1", "a", 50, 10, 0, 50, 0, 100), ("dev1", "b", 51, 1, 0, 1, 0, 1), ("dev1", "c", 52, 10, 0, 30, 0, 100),
            ("dev1", "d", 53, 10, 3, 0, 0, 100), ("dev1", "e", 54, 10, 2, 0, 0, 100), ("dev2", "x", 55, 10, 1, 25, 20, 30),
            ("dev2", "y", 56, 10, 2, 60, 40, 80),
        };
        foreach (var s in steps) log.Add($"add {s.C}.{s.F}: {(AddStreamViaDialog(s.C, s.F, s.A, s.Sc, s.M, s.V, s.Mn, s.Mx) is { Length: > 0 } e ? "LOI " + e : "ok")}");
        // thêm trùng D phải bị từ chối
        log.Add($"dup_addr_rejected={AddStreamViaDialog("x1", "v", 52, 1, 0, 0, 0, 1).Contains("D52")}");
        log.Add($"streams={_model.Fields().Length}");
        // kiểu dữ liệu nhiều word + struct (qua hộp thoại thật)
        {
            using var d = NewStreamDialog(null);
            F<ComboBox>(d, "_child").Text = "dev3"; F<TextBox>(d, "_field").Text = "S1";
            F<NumericUpDown>(d, "_addr").Value = 100;
            F<ComboBox>(d, "_type").SelectedIndex = 7;   // STRUCT
            var grid = F<DataGridView>(d, "_grid");
            grid.Rows.Clear();
            grid.Rows.Add("temp", "REAL", "1", "Cố định", "12.5", "", "", "", "");
            grid.Rows.Add("count", "DINT", "1", "Cố định", "-70000", "", "", "", "");
            grid.Rows.Add("on", "BOOL", "1", "Cố định", "1", "", "", "", "");
            typeof(StreamDialog).GetMethod("Commit", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(d, null);
            var okDlg = F<Form>(d, "_f").DialogResult == DialogResult.OK;
            if (okDlg) ApplyStream(d);
            log.Add($"struct_dialog_ok={okDlg} err={F<Label>(d, "_err").Text}");
            log.Add($"struct_layout temp@{_model.MapOf("dev3", "temp")?.Addr} count@{_model.MapOf("dev3", "count")?.Addr} on@{_model.MapOf("dev3", "on")?.Addr}");
            var f32 = BitConverter.SingleToUInt32Bits(12.5f);
            log.Add($"float32_words_ok={_model.Get(100) == (ushort)(f32 >> 16) && _model.Get(101) == (ushort)f32}");
            log.Add($"int32_words_ok={_model.Get(102) == unchecked((ushort)((uint)-70000 >> 16)) && _model.Get(103) == unchecked((ushort)(uint)-70000) && _model.Get(104) == 1}");
            _model.Set(102, 0, "gateway"); _model.Set(103, 5, "gateway");   // gateway ghi lại DINT = 5
            log.Add($"int32_gateway_write={_model.Fields().First(x => x.Child == "dev3" && x.Field == "count").Value}");
            log.Add($"overlap_rejected={AddStreamViaDialog("dev4", "z", 101, 1, 0, 0, 0, 1).Contains("D101")}");
        }
        // quyền: luồng chỉ đọc từ chối ghi của gateway; chỉ ghi và đọc/ghi nhận
        _model.SetMeta("dev1", "a", new PlcModel.Meta("modbus", PlcModel.Access.Read, "1"));
        _model.SetMeta("dev1", "c", new PlcModel.Meta("s7", PlcModel.Access.ReadWrite, "1"));
        _model.Set(50, 777, "gateway"); _model.Set(52, 55, "gateway");
        log.Add($"read_only_denied={_model.Get(50) != 777} readwrite_accepted={_model.Get(52) == 55}");

        Cfg("modbus").Host = "127.0.0.1"; Cfg("modbus").Port = 1502;   // Modbus TCP
        RefreshStreams();
        await ToggleAsync();
        log.Add($"running={_eps.Count > 0}");
        var t0 = DateTime.Now;
        var samples = new List<string>();
        while ((DateTime.Now - t0).TotalSeconds < 70)
        {
            await Task.Delay(5000);
            var v = _model.Fields().ToDictionary(f => $"{f.Child}.{f.Field}", f => f.Value);
            samples.Add(string.Join(" ", v.Select(kv => $"{kv.Key}={kv.Value.ToString("0.##", CultureInfo.InvariantCulture)}")) + $" peers={_eps.Sum(e => e.Ep.Peers)}");
        }
        // xoá luồng: từ chối thì còn, đồng ý thì mất
        void Select(string c, string f) { foreach (DataGridViewRow r in _streams.Rows) if (Convert.ToString(r.Cells[0].Value) == c && Convert.ToString(r.Cells[2].Value) == f) _streams.CurrentCell = r.Cells[0]; }
        var before = _model.Fields().Length;
        Select("dev2", "y"); Ask.Override = false; DeleteStream();
        log.Add($"delete_declined_kept={_model.Fields().Length == before}");
        Ask.Override = true; DeleteStream();
        log.Add($"delete_confirmed_removed={_model.Fields().Length == before - 1 && _model.MapOf("dev2", "y") == null}");
        Ask.Override = null;
        log.Add($"commands_received={_actions.Rows.Count}");
        log.AddRange(samples);
        File.WriteAllLines(Path.Combine(outDir, "plcsim-result.txt"), log);
        await StopAsync();
        Close();
    }
}
