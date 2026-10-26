using System.Windows;
using Plciot.Scada;

namespace Plciot.Solution.Conveyor;

/// <summary>Chạy cửa sổ WPF trên luồng STA riêng (framework chạy bất đồng bộ nên không thể dùng luồng Main).</summary>
public sealed class ConveyorWpfUi : IScadaUi
{
    public Task RunAsync(SolutionContext ctx, CancellationToken ct)
    {
        var done = new TaskCompletionSource();
        var t = new Thread(() =>
        {
            try
            {
                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                using var reg = ct.Register(() => app.Dispatcher.BeginInvokeShutdown(System.Windows.Threading.DispatcherPriority.Normal));
                app.Run(new MainWindow(ctx));
            }
            finally { done.TrySetResult(); }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        return done.Task;
    }
}
