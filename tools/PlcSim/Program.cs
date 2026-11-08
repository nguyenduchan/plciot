namespace PlcSim;

static class Program
{
    /// <summary>--selftest THU_MUC: thêm luồng bằng hộp thoại thật, chạy Modbus TCP cổng 1502 trong 45 giây, ghi plcsim-result.txt rồi thoát.</summary>
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var form = new MainForm();
        var i = Array.IndexOf(args, "--selftest");
        if (i >= 0 && i + 1 < args.Length) form.Shown += async (_, _) => await form.SelfTestAsync(args[i + 1]);
        Application.Run(form);
    }
}
