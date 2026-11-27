using System.Text.Json;
using GatewayApp;

/// <summary>Bản nháp ánh xạ gateway mua sẵn từ bản tin của hãng (NocodeDraft) — định dạng khớp cloud/app/src/nocodeMap.js.</summary>
public class NocodeDraftTests
{
    static JsonElement Fields(string json) => JsonDocument.Parse(json).RootElement.GetProperty("devices")[0].GetProperty("fields");

    [Fact]
    public void BanTinPhang_USR_N720_RaMoiGiaTriSo()
    {
        var f = Fields(NocodeDraft.FromRaw("{\"I1\":123,\"RUN\":1,\"t\":\"1795770000\",\"name\":\"tram\",\"ok\":true}"));
        var paths = f.EnumerateArray().Select(x => x.GetProperty("path").GetString()).ToList();
        Assert.Equal(new[] { "$.I1", "$.RUN", "$.t", "$.ok" }, paths);   // chuỗi số + bool là số; chuỗi chữ bị bỏ
        Assert.Equal("I1", f[0].GetProperty("key").GetString());
        Assert.Equal("kpi", f[0].GetProperty("widget").GetString());
    }

    [Fact]
    public void LongNhau_Mang_TenLa()
    {
        var f = Fields(NocodeDraft.FromRaw("{\"data\":{\"a b\":1,\"x\":[{\"v\":2}]}}"));
        var paths = f.EnumerateArray().Select(x => x.GetProperty("path").GetString()).ToList();
        Assert.Equal(new[] { "$.data['a b']", "$.data.x[0].v" }, paths);
        Assert.Equal(new[] { "data_a_b", "data_x_0_v" }, f.EnumerateArray().Select(x => x.GetProperty("key").GetString()));
    }

    [Fact]
    public void KhongPhaiJson_RaBanRong_Va_KhoaTrungDuocDanhSo()
    {
        Assert.Equal(0, Fields(NocodeDraft.FromRaw("không phải json")).GetArrayLength());
        var f = Fields(NocodeDraft.FromRaw("{\"a.b\":1,\"a_b\":2}"));
        Assert.Equal(new[] { "a_b", "a_b_2" }, f.EnumerateArray().Select(x => x.GetProperty("key").GetString()));
    }

    [Fact]
    public void MauM100_RelayGhiDuoc_KhopMauBaoDuLieu()
    {
        var json = NocodeDraft.M100Template();
        var root = JsonDocument.Parse(json).RootElement;
        Assert.Equal("usr_rw_prot", root.GetProperty("control").GetString());
        var f = Fields(json);
        var relays = f.EnumerateArray().Where(x => x.TryGetProperty("writable", out var w) && w.GetBoolean()).ToList();
        Assert.Equal(new[] { "DO1", "DO2" }, relays.Select(x => x.GetProperty("point").GetString()));
        // mọi path trong ánh xạ phải có trong mẫu báo dữ liệu của M100
        var report = JsonDocument.Parse(NocodeDraft.M100ReportTemplate).RootElement;
        foreach (var x in f.EnumerateArray()) Assert.True(report.TryGetProperty(x.GetProperty("path").GetString()![2..], out _));
        var outPath = Environment.GetEnvironmentVariable("NOCODE_M100_OUT");
        if (!string.IsNullOrEmpty(outPath)) File.WriteAllText(outPath, json);
    }

    [Fact]
    public void ToiDa32Field()
    {
        var raw = "{" + string.Join(",", Enumerable.Range(0, 50).Select(i => $"\"k{i}\":{i}")) + "}";
        Assert.Equal(32, Fields(NocodeDraft.FromRaw(raw)).GetArrayLength());
    }
}
