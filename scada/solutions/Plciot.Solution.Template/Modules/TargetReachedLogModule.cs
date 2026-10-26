using Plciot.Scada;

namespace Plciot.Solution.Template.Modules;

/// <summary>
/// VÍ DỤ logic riêng: ghi nhật ký khi băng tải đếm đủ số lượng mục tiêu. Module chỉ dùng <see cref="SolutionContext"/>
/// (IScadaView/ScadaCore) nên không cần sửa framework. Thay bằng logic thật của khách hàng (cảnh báo, báo cáo ca, thông báo...).
/// </summary>
public sealed class TargetReachedLogModule : IScadaModule
{
    CancellationTokenSource? _cts;
    Task? _loop;

    public string Name => "TargetReachedLog";

    public Task StartAsync(SolutionContext ctx, CancellationToken ct)
    {
        _cts = new CancellationTokenSource();
        _loop = Task.Run(async () =>
        {
            var wasDone = false;
            while (!_cts.IsCancellationRequested)
            {
                var s = ctx.View.State;
                var done = s.Conveyor == 2;                          // 2 = đủ số lượng
                if (done && !wasDone) ctx.Core?.Emit($"Đã đếm đủ {s.Count}/{s.Target} sản phẩm.");
                wasDone = done;
                try { await Task.Delay(500, _cts.Token); } catch (OperationCanceledException) { break; }
            }
        });
        return Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        _cts?.Cancel();
        if (_loop != null) await _loop;
    }
}
