using Plciot.Scada;

namespace Plciot.Solution.Conveyor;

internal static class Program
{
    // Toàn bộ vòng đời (nạp cấu hình, nối PLC, module, giao diện, tắt gọn) do framework lo.
    [STAThread]
    private static int Main(string[] args) => SolutionRunner.RunAsync(new ConveyorSolution(), args).GetAwaiter().GetResult();
}
