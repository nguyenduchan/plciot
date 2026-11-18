using GatewayApp.Ui;

namespace GatewayApp.Tests;

/// <summary>Tên tiếng Việt → mã ASCII của thiết bị/field (bỏ dấu, đ→d), không phân biệt hoa thường.</summary>
public class VnTests
{
    [Theory]
    [InlineData("Bồn nước số 1", "bon_nuoc_so_1")]
    [InlineData("Đồng hồ điện năng", "dong_ho_dien_nang")]
    [InlineData("  Máy bơm  (chính) ", "may_bom_chinh")]
    [InlineData("Quạt/Thông-gió", "quat_thong_gio")]
    [InlineData("Nhiệt độ °C", "nhiet_do_c")]
    [InlineData("!!!", "")]
    public void Slug(string input, string want) => Assert.Equal(want, Vn.Slug(input));

    [Fact]
    public void Slug_cat_do_dai_va_khong_ket_thuc_bang_gach() =>
        Assert.True(Vn.Slug(new string('ế', 10) + " " + new string('a', 60), 20).Length <= 20 && !Vn.Slug("abc def ghi", 4).EndsWith('_'));

    [Fact]
    public void Slug_giu_gach_ngang_khi_cho_phep() => Assert.Equal("kho-lanh_1", Vn.Slug("Kho-lạnh 1", 48, allowDash: true));
}
