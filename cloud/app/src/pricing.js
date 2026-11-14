/**
 * Ước tính tiền nâng cấp theo số widget của người dùng — CHỈ để admin tham khảo khi báo giá (không hiện trong app người dùng,
 * không tạo đơn, không thanh toán; xem docs/CHAT-COMPLIANCE.md).
 *
 * Công thức: giá mỗi widget = 3 × (chi phí vận hành server của MỘT widget giám sát trong 10 năm)
 *   chi phí 1 widget / 10 năm = PRICING_VPS_VND_MONTH × 12 × 10 ÷ PRICING_CAPACITY_WIDGETS
 * trong đó PRICING_CAPACITY_WIDGETS = số widget mà VPS gánh được khi mỗi widget gửi 1 tin mỗi giây.
 * Tổng = giá mỗi widget × số widget của người dùng. Làm tròn lên 1.000đ.
 */
export const PRICING = Object.freeze({
  vpsMonthVnd: () => Number(process.env.PRICING_VPS_VND_MONTH || 260000),
  capacityWidgets: () => Math.max(1, Number(process.env.PRICING_CAPACITY_WIDGETS || 500)),
  years: () => Math.max(1, Number(process.env.PRICING_YEARS || 10)),
  multiplier: () => Math.max(1, Number(process.env.PRICING_MULTIPLIER || 3)),
  msgPerSecPerWidget: 1,
});

const round1000 = (n) => Math.ceil(n / 1000) * 1000;

export function quoteForWidgets(widgets) {
  const n = Math.max(0, Math.floor(Number(widgets) || 0));
  const cost = PRICING.vpsMonthVnd(); const cap = PRICING.capacityWidgets(); const years = PRICING.years(); const mult = PRICING.multiplier();
  const opCostPerWidget = (cost * 12 * years) / cap;          // vận hành 1 widget trong `years` năm
  const perWidget = round1000(opCostPerWidget * mult);
  return {
    widgets: n,
    perWidget,
    total: perWidget * n,
    assumptions: { vpsMonthVnd: cost, capacityWidgets: cap, years, multiplier: mult, msgPerSecPerWidget: PRICING.msgPerSecPerWidget, opCostPerWidget: Math.round(opCostPerWidget) },
  };
}
