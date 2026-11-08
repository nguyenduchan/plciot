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
        // chế độ: 0 cố định, 1 ngẫu nhiên, 2 sin, 3 tăng dần, 4 mô phỏng bồn
        var steps = new (string C, string F, int A, double Sc, int M, double V, double Mn, double Mx)[]
        {
            ("tank1", "level", 50, 10, 4, 50, 0, 100), ("pump1", "run", 51, 1, 0, 1, 0, 1), ("pump1", "speed", 52, 10, 0, 30, 0, 100),
            ("pump1", "flow", 53, 10, 4, 0, 0, 100), ("pump1", "hours", 54, 10, 4, 0, 0, 100), ("env1", "t", 55, 10, 1, 25, 20, 30),
            ("env1", "h", 56, 10, 2, 60, 40, 80),
        };
        foreach (var s in steps) log.Add($"add {s.C}.{s.F}: {(AddStreamViaDialog(s.C, s.F, s.A, s.Sc, s.M, s.V, s.Mn, s.Mx) is { Length: > 0 } e ? "LOI " + e : "ok")}");
        // thêm trùng D phải bị từ chối
        log.Add($"dup_addr_rejected={AddStreamViaDialog("x1", "v", 52, 1, 0, 0, 0, 1).Contains("D52")}");
        log.Add($"streams={_model.Fields().Length}");

        _proto.SelectedIndex = 0; _host.Text = "127.0.0.1"; _port.Value = 1502;   // Modbus TCP
        RefreshStreams();
        await ToggleAsync();
        log.Add($"running={_ep != null}");
        var t0 = DateTime.Now;
        var samples = new List<string>();
        while ((DateTime.Now - t0).TotalSeconds < 70)
        {
            await Task.Delay(5000);
            var v = _model.Fields().ToDictionary(f => $"{f.Child}.{f.Field}", f => f.Value);
            samples.Add(string.Join(" ", v.Select(kv => $"{kv.Key}={kv.Value.ToString("0.##", CultureInfo.InvariantCulture)}")) + $" peers={_ep?.Peers}");
        }
        // xoá luồng: từ chối thì còn, đồng ý thì mất
        void Select(string c, string f) { foreach (DataGridViewRow r in _streams.Rows) if (Convert.ToString(r.Cells[0].Value) == c && Convert.ToString(r.Cells[1].Value) == f) _streams.CurrentCell = r.Cells[0]; }
        var before = _model.Fields().Length;
        Select("env1", "h"); Ask.Override = false; DeleteStream();
        log.Add($"delete_declined_kept={_model.Fields().Length == before}");
        Ask.Override = true; DeleteStream();
        log.Add($"delete_confirmed_removed={_model.Fields().Length == before - 1 && _model.MapOf("env1", "h") == null}");
        Ask.Override = null;
        log.Add($"commands_received={_actions.Rows.Count}");
        log.AddRange(samples);
        File.WriteAllLines(Path.Combine(outDir, "plcsim-result.txt"), log);
        await StopAsync();
        Close();
    }
}
