namespace Plciot.Scada;

/// <summary>Một giải pháp đang chạy (đã nối PLC/máy chính, đã khởi động module). Dùng cho kiểm thử và cho giao diện tự quản vòng đời.</summary>
public sealed class RunningSolution : IAsyncDisposable
{
    readonly List<IScadaModule> _modules;
    readonly RemoteScreenClient? _client;
    public SolutionContext Context { get; }
    public bool RestartRequested { get; internal set; }

    internal RunningSolution(SolutionContext ctx, List<IScadaModule> modules, RemoteScreenClient? client)
    {
        Context = ctx; _modules = modules; _client = client;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var m in _modules) { try { await m.StopAsync(); } catch { /* một module lỗi không được chặn tắt máy */ } }
        if (Context.Host != null) await Context.Host.DisposeAsync();
        if (_client != null) await _client.DisposeAsync();
    }
}

/// <summary>
/// Vòng đời chuẩn của mọi giải pháp: nạp cấu hình → giải pháp khoá các quyết định → kiểm tra → khởi động máy chính (lõi + dịch vụ)
/// hoặc máy màn hình phụ (client) → khởi động module → chạy giao diện → tắt gọn. Khách hàng chỉ gọi <see cref="RunAsync"/> từ Main.
/// <code>
/// args: --config đường_dẫn   --station main|screen   --headless
/// </code>
/// </summary>
public static class SolutionRunner
{
    public static async Task<int> RunAsync(IScadaSolution solution, string[] args)
    {
        using var quit = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Cancel(); };
        var headless = args.Contains("--headless");
        for (;;)
        {
            RunningSolution run;
            try { run = await StartAsync(solution, args); }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or IOException)
            {
                Console.Error.WriteLine($"[{solution.Name}] Không khởi động được: {ex.Message}");
                return 1;
            }
            try
            {
                var restart = false;
                var ctx = run.Context;
                ctx.View.Log += Console.WriteLine;
                var ui = headless ? null : solution.CreateUi();
                if (ui != null)
                {
                    await ui.RunAsync(ctx, quit.Token);
                    restart = run.RestartRequested;
                }
                else
                {
                    Console.WriteLine($"[{solution.Name}] đang chạy ({ctx.Config.Station}, {ctx.Config.Topology}). Ctrl+C để dừng.");
                    try { await Task.Delay(Timeout.Infinite, quit.Token); } catch (OperationCanceledException) { }
                }
                if (!restart) return 0;
            }
            finally { await run.DisposeAsync(); }
        }
    }

    /// <summary>Nạp + khoá cấu hình, khởi động máy chính hoặc máy phụ và các module (chưa chạy giao diện).</summary>
    public static async Task<RunningSolution> StartAsync(IScadaSolution solution, string[] args)
    {
        var path = ArgValue(args, "--config") ?? ConfigStore.PathFor(solution.Name);
        ScadaConfig cfg;
        if (File.Exists(path)) cfg = ConfigStore.Load(path);
        else
        {
            cfg = solution.CreateDefaultConfig();
            ConfigStore.Save(path, cfg);                         // tạo file để nhân viên hiện trường sửa IP/mật khẩu
        }
        var stationArg = ArgValue(args, "--station");
        if (stationArg != null) cfg.Station = stationArg.Equals("screen", StringComparison.OrdinalIgnoreCase) ? StationRole.Screen : StationRole.Main;
        solution.Enforce(cfg);
        var err = cfg.Validate();
        if (err != null) throw new InvalidOperationException(err);

        RunningSolution? running = null;
        var ctxBase = (IScadaView view, ScadaCore? core, ScadaHost? host) => new SolutionContext
        {
            Solution = solution, Config = cfg, ConfigPath = path, View = view, Core = core, Host = host,
            RequestRestart = () => { if (running != null) running.RestartRequested = true; },
        };

        var modules = new List<IScadaModule>();
        if (cfg.Station == StationRole.Screen)
        {
            var client = new RemoteScreenClient(cfg.ScreenServerUrl, cfg.ScreenServerUser, cfg.ScreenServerPassword);
            client.Start();
            running = new RunningSolution(ctxBase(client, null, null), modules, client);
            return running;
        }

        var host = new ScadaHost(cfg);
        await host.StartAsync();
        running = new RunningSolution(ctxBase(host.View, host.Core, host), modules, null);
        using var cts = new CancellationTokenSource();
        foreach (var m in solution.CreateModules())
        {
            await m.StartAsync(running.Context, cts.Token);
            modules.Add(m);
            host.Core.Emit($"Module khởi động: {m.Name}");
        }
        return running;
    }

    static string? ArgValue(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}

/// <summary>Giải pháp mặc định, chạy nền, không giao diện, một màn hình: dùng cho Host và để thử nhanh.</summary>
public sealed class DefaultSolution : IScadaSolution
{
    public string Name => "default";
    public ScadaConfig CreateDefaultConfig() => new ScadaConfig().UseSingleScreen();
    public void Enforce(ScadaConfig cfg) { }
    public IEnumerable<IScadaModule> CreateModules() => Array.Empty<IScadaModule>();
    public IScadaUi? CreateUi() => null;
}
