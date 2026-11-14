/**
 * Gợi ý giá theo từng gói — CHỈ để admin tham khảo khi báo giá (không hiện trong app người dùng, không tạo đơn,
 * không thanh toán; xem docs/CHAT-COMPLIANCE.md và docs/PLANS-PRICING.md).
 *
 * Hai phần:
 *  1) Giá sàn theo chi phí (đo thật, docs/CHAT-COMPLIANCE.md → "Đo sức chứa"): chia chi phí VPS theo phần ĐĨA mà mỗi widget chiếm
 *     (đĩa là giới hạn thật; CPU còn dư rất nhiều). Mỗi tin telemetry ~252 byte trong DB.
 *  2) Giá niêm yết đề xuất cho xưởng vừa/nhỏ và trạm bơm tại Việt Nam:
 *     - Cơ bản: trọn gói theo THÁNG (tối đa 30 widget)
 *     - Nâng cao: theo widget mỗi tháng, có mức tối thiểu
 *     - Nhà máy / partner: TRẢ MỘT LẦN cho 10 năm = 3 × chi phí vận hành 10 năm của mỗi widget (giá sàn × 3)
 *   Tất cả đều là gợi ý, đặt lại bằng biến môi trường PRICE_* / PRICING_*.
 */
import { PLAN_CATALOG } from './entitlements.js';
import { defaultDays } from './retention.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const DAY = 86_400_000;

export const PRICING = Object.freeze({
  vpsMonthVnd: () => num('PRICING_VPS_VND_MONTH', 260000),
  diskUsableGb: () => num('PRICING_DISK_USABLE_GB', 15),          // 30 GB trống, chừa 50% dự phòng
  bytesPerRow: () => num('PRICING_BYTES_PER_ROW', 252),           // đo thật, gồm chỉ mục
  cpuCapacityWidgets: () => num('PRICING_CPU_CAPACITY_WIDGETS', 1500),   // đo ≥ 4.000, chia an toàn (chưa tính policy)
  years: () => num('PRICING_YEARS', 10),
  multiplier: () => num('PRICING_MULTIPLIER', 3),
  basicMonth: () => num('PRICE_BASIC_MONTH', 99000),              // Cơ bản: trọn gói / tháng (≤ 30 widget)
  proPerWidgetMonth: () => num('PRICE_PRO_PER_WIDGET_MONTH', 8000),
  proMinMonth: () => num('PRICE_PRO_MIN_MONTH', 199000),
  msgPerSecPerWidget: 1,
});

const round = (n, step) => Math.ceil(n / step) * step;

/** Số dòng DB một widget chiếm ở trạng thái ổn định (lịch sử chi tiết + phần gộp thưa dài hạn nếu có). */
export function rowsPerWidget(plan) {
  const hotDays = plan.retention === 'default' ? defaultDays() : plan.retention === 0 ? (plan.hotDays || 30) : plan.retention;
  const hotMs = Math.max(1000, Number(plan.telemetryMinMs) || 1000);
  let rows = (hotDays * DAY) / hotMs;
  if (plan.retention === 0 && plan.coldSampleMs) {
    const coldDays = PRICING.years() * 365 - hotDays;
    rows += (coldDays * DAY) / plan.coldSampleMs;
  }
  return Math.round(rows);
}

/** Giá sàn theo chi phí cho 1 widget / tháng (lớn hơn trong phần đĩa và phần CPU) và cả `years` năm. */
export function costFloor(plan) {
  const bytes = rowsPerWidget(plan) * PRICING.bytesPerRow();
  const diskShare = bytes / (PRICING.diskUsableGb() * 1024 ** 3);
  const share = Math.max(diskShare, 1 / PRICING.cpuCapacityWidgets());
  const perMonth = PRICING.vpsMonthVnd() * share;
  return { bytesPerWidget: bytes, share, perWidgetMonth: perMonth, perWidgetYears: perMonth * 12 * PRICING.years() };
}

/** Gợi ý giá cho một gói với `widgets` widget. */
export function quoteForPlan(planId, widgets) {
  const plan = PLAN_CATALOG[planId];
  if (!plan) return null;
  const n = Math.max(0, Math.floor(Number(widgets) || 0));
  const floor = costFloor(plan);
  const base = { plan: planId, label: plan.label, widgets: n, widgetCap: plan.widgets ?? null, overCap: plan.widgets != null && n > plan.widgets, floorPerWidgetMonth: Math.round(floor.perWidgetMonth), storageMbPerWidget: Math.round(floor.bytesPerWidget / 1048576) };
  if (planId === 'free') return { ...base, kind: 'free', total: 0, note: 'Miễn phí (tối đa 5 widget).' };
  if (planId === 'monitor') {
    const total = PRICING.basicMonth();
    return { ...base, kind: 'monthly', total, perMonth: total, perYear: total * 12, note: `Trọn gói ${total.toLocaleString('vi-VN')}đ/tháng, tối đa ${plan.widgets} widget.` };
  }
  if (planId === 'pro') {
    const total = Math.max(PRICING.proMinMonth(), round(PRICING.proPerWidgetMonth() * n, 1000));
    return { ...base, kind: 'monthly', total, perMonth: total, perYear: total * 12, note: `${PRICING.proPerWidgetMonth().toLocaleString('vi-VN')}đ/widget/tháng, tối thiểu ${PRICING.proMinMonth().toLocaleString('vi-VN')}đ/tháng.` };
  }
  // Trả một lần cho 10 năm: 3 × chi phí vận hành 10 năm của mỗi widget
  const perWidget = round(floor.perWidgetYears * PRICING.multiplier(), 10000);
  const total = perWidget * n;
  return { ...base, kind: 'one_time', years: PRICING.years(), perWidget, total, equivalentPerMonth: Math.round(total / (PRICING.years() * 12)), note: `Trả một lần, dùng ${PRICING.years()} năm: ${PRICING.multiplier()} × chi phí vận hành ${PRICING.years()} năm của mỗi widget.` };
}

/** Gợi ý giá cho mọi gói theo số widget hiện có của người dùng (admin chọn gói rồi xem). */
export function quotesForWidgets(widgets) {
  const out = {};
  for (const id of Object.keys(PLAN_CATALOG)) out[id] = quoteForPlan(id, widgets);
  return out;
}

export function pricingAssumptions() {
  return {
    vpsMonthVnd: PRICING.vpsMonthVnd(), diskUsableGb: PRICING.diskUsableGb(), bytesPerRow: PRICING.bytesPerRow(),
    cpuCapacityWidgets: PRICING.cpuCapacityWidgets(), years: PRICING.years(), multiplier: PRICING.multiplier(), msgPerSecPerWidget: PRICING.msgPerSecPerWidget,
  };
}
