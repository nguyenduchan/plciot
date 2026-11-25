using System.Text;
using System.Text.Json;

namespace Plciot.Scada.Tests;

/// <summary>Thời gian tối thiểu giữa hai lần đổi trạng thái đầu ra số (PackMap.MinToggleMs): bảo vệ tiếp điểm relay khỏi bật/tắt dồn dập.</summary>
public class ToggleGuardTests
{
    static PackMap Do(int minMs) => new() { Child = "lamp", Field = "on", Address = 20, MinToggleMs = minMs, Protocol = "ModbusTcp", Params = new() { ["unit"] = "0" } };

    [Fact]
    public void Only_a_change_of_state_counts_and_repeats_are_always_allowed()
    {
        long now = 1000;
        var g = new ToggleGuard(() => now);
        var f = Do(2000);
        Assert.True(g.TryTake(f, 1, out _));                  // lần đầu: luôn được
        Assert.True(g.TryTake(f, 1, out _));                  // gửi lại đúng giá trị đang có: được, không lùi mốc
        now += 500;
        Assert.False(g.TryTake(f, 0, out var wait));          // đổi sau 0,5 s < 2 s → chặn
        Assert.Equal(1500, wait);
        now += 1500;
        Assert.True(g.TryTake(f, 0, out _));                  // đủ 2 s → được
        Assert.False(g.TryTake(f, 1, out _));                 // đổi lại ngay → chặn
    }

    [Fact]
    public void Zero_means_no_limit()
    {
        var g = new ToggleGuard(() => 0);
        var f = Do(0);
        for (var i = 0; i < 10; i++) Assert.True(g.TryTake(f, i % 2, out _));
    }

    [Fact]
    public void Undo_restores_previous_slot_after_failed_write()
    {
        long now = 0;
        var g = new ToggleGuard(() => now);
        var f = Do(1000);
        g.TryTake(f, 1, out _);
        now = 5000;
        var prev = g.Peek(f);
        Assert.True(g.TryTake(f, 0, out _));
        g.Undo(f, prev.Value, prev.At);                       // ghi PLC lỗi
        Assert.True(g.TryTake(f, 0, out _));                  // thử lại ngay không bị chặn oan
    }

    sealed class MemDriver : IRegisterDriver
    {
        public readonly ushort[] Regs = new ushort[300];
        public int Writes;
        public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default) => Task.FromResult(Regs[address..(address + count)]);
        public Task WriteAsync(int address, ushort value, CancellationToken ct = default) { Regs[address] = value; Interlocked.Increment(ref Writes); return Task.CompletedTask; }
        public void Dispose() { }
    }

    [Fact]
    public async Task Core_rejects_fast_toggle_from_every_source_with_wait_hint()
    {
        var drv = new MemDriver();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", PollMs = 200, WebEnabled = false, Mobile = MobileAccess.Control,
            Pack = new() { Do(60_000) },
            Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = 1502 } },
        };
        await using var core = new ScadaCore(cfg, null, new PackDriverPool(cfg, (_, _) => drv));
        static byte[] Cmd(double v) => Encoding.UTF8.GetBytes($"{{\"id\":\"k\",\"child\":\"lamp\",\"key\":\"on\",\"v\":{v}}}");

        Assert.Contains("\"ok\":true", await core.ExecuteKeyAsync(Cmd(1), ControlSource.Mobile, "web"));
        Assert.Contains("\"ok\":true", await core.ExecuteKeyAsync(Cmd(1), ControlSource.LocalScreen, "ui"));   // lặp lại: được
        var ack = await core.ExecuteKeyAsync(Cmd(0), ControlSource.LocalScreen, "ui");                         // nguồn khác vẫn bị chặn
        using var doc = JsonDocument.Parse(ack!);
        Assert.False(doc.RootElement.GetProperty("ok").GetBoolean());
        Assert.Equal("toggle_too_fast", doc.RootElement.GetProperty("err").GetString());
        Assert.InRange(doc.RootElement.GetProperty("waitMs").GetInt32(), 50_000, 60_000);
        Assert.Equal(1, drv.Regs[20]);                                                                         // DO vẫn bật
        Assert.Equal(2, drv.Writes);
    }

    [Fact]
    public void Config_message_carries_toggleMs_for_writable_outputs_only()
    {
        var cfg = new ScadaConfig { Device = "GW01", Pack = new() { Do(1500), new PackMap { Child = "lamp", Field = "fb", Address = 10, Access = PackAccess.Read, MinToggleMs = 900 } } };
        using var doc = JsonDocument.Parse(ConfigBuilder.Build(cfg));
        var fields = doc.RootElement.GetProperty("devices")[0].GetProperty("fields");
        Assert.Equal(1500, fields[0].GetProperty("toggleMs").GetInt32());
        Assert.False(fields[1].TryGetProperty("toggleMs", out _));
    }
}
