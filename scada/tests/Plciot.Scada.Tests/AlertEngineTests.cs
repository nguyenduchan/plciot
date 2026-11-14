using System.Text;
using System.Text.Json;
using Xunit;

namespace Plciot.Scada.Tests;

public class AlertEngineTests
{
    static byte[] Tele(double level) => Encoding.UTF8.GetBytes("{\"schema\":2,\"d\":{\"tank1\":{\"level\":" + level.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}}}");

    static (AlertEngine E, Func<long> Clock, Action<long> Advance) Make()
    {
        long t = 1_000_000;
        var e = new AlertEngine(() => new[] { ("tank1.level", "Bồn nước", "Mức nước", "%", (double?)15, (double?)92) }, () => t);
        return (e, () => t, d => t += d);
    }

    [Fact]
    public void Fires_only_on_transition_and_respects_cooldown()
    {
        var (e, _, adv) = Make();
        Assert.Empty(e.Evaluate(Tele(50)));
        var hi = e.Evaluate(Tele(95));
        Assert.Single(hi);
        using (var doc = JsonDocument.Parse(hi[0]))
        {
            Assert.Equal("high", doc.RootElement.GetProperty("lv").GetString());
            Assert.Equal("tank1.level", doc.RootElement.GetProperty("k").GetString());
            Assert.Contains("vượt ngưỡng cao", doc.RootElement.GetProperty("txt").GetString());
        }
        Assert.Empty(e.Evaluate(Tele(96)));                 // vẫn cao: không báo lặp
        adv(1000); Assert.Empty(e.Evaluate(Tele(50)));
        adv(1000); Assert.Single(e.Evaluate(Tele(10)));     // thấp: báo mức khác
        adv(1000); Assert.Empty(e.Evaluate(Tele(50)));
        adv(1000); Assert.Empty(e.Evaluate(Tele(95)));      // cùng mức, trong cooldown
        adv(AlertEngine.CooldownMs); Assert.Empty(e.Evaluate(Tele(50)));
        adv(1000); Assert.Single(e.Evaluate(Tele(95)));     // hết cooldown: báo lại
    }

    [Fact]
    public void Ignores_fields_without_limits_and_bad_payload()
    {
        var e = new AlertEngine(() => new[] { ("tank1.level", "Bồn", "Mức", "", (double?)null, (double?)null) });
        Assert.Empty(e.Evaluate(Tele(999)));
        Assert.Empty(e.Evaluate(Encoding.UTF8.GetBytes("không phải json")));
    }
}
