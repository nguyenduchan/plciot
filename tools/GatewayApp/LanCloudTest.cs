namespace GatewayApp;

/// <summary>
/// Việc cloud cho board Waveshare qua LAN, không giao diện (--lancloud KQ.txt --lan-target IP:443 --cloud-action register|enroll
/// [--cloud-api URL] --cloud-value-file FILE): nối bằng khoá PC rồi gọi POST /api/cloud (đúng đường nút Cloud của cửa sổ Waveshare dùng).
/// Dùng khi thử đăng ký board với server mà không bấm tay. Kết quả ghi vào KQ.txt.
/// </summary>
public sealed partial class MainForm
{
    public async Task LanCloudAsync(string result)
    {
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var lines = new List<string>();
        try
        {
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var value = File.ReadAllText(ArgValue(args, "--cloud-value-file"));
            var r = await c.CloudAsync(ArgValue(args, "--cloud-action"), ArgValue(args, "--cloud-api"), value);
            lines.Add($"{(r.Ok ? "PASS" : "FAIL")} cloud {ArgValue(args, "--cloud-action")} — {r.Msg ?? r.Err}");
            var st = await c.StateAsync();
            lines.Add($"INFO cloud={st.Cloud} mode={st.Mode} status={st.Status}");
            c.Dispose();
        }
        catch (Exception e) { lines.Add("FAIL " + RemoteClient.Explain(e)); }
        File.WriteAllLines(result, lines);
        Close();
    }
}
