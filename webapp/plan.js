'use strict';
/**
 * Gói dịch vụ trên webapp: giải thích vì sao widget bị khoá / lệnh bị từ chối và dẫn người dùng tới chỗ NÂNG GÓI.
 *   PlanUi.show(code)   hộp thông báo (đáy màn hình) kèm nút "Nâng gói"
 *   PlanUi.goUpgrade()  chuyển sang Cài đặt → Gói dịch vụ (bảng so sánh + nút sao chép yêu cầu gửi quản trị viên)
 *   PlanUi.update(sub, plan)  cập nhật bảng gói theo dữ liệu server
 * Thanh toán không nằm trong app: quản trị viên gán gói (trang admin → Người dùng).
 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let sub = null; let plan = null; let username = '';
  let days = 30; let prices = null; let priceWidgets = null;
  const DAYS = [7, 30, 90, 180, 365];
  const vnd = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

  async function loadPrices() {
    let session = null; try { session = JSON.parse(localStorage.getItem('session')); } catch { /* */ }
    if (!session?.token || session.demo) return;
    try {
      const r = await fetch(`${session.apiBase || location.origin}/api/support/prices?days=${days}`, { headers: { Authorization: `Bearer ${session.token}` } });
      if (!r.ok) return;
      const j = await r.json(); prices = j.prices; priceWidgets = j.widgets;
      renderTable();
      window.dispatchEvent(new Event('plan-prices'));
    } catch { /* không có giá: vẫn hiện bảng gói */ }
  }

  function priceLine(id) {
    const q = prices?.[id];
    if (!q) return '';
    if (q.kind === 'free') return '<small class="price">Giá: <b>miễn phí</b></small>';
    if (!q.eligible) return `<small class="price off">${esc(q.reason || 'Không phù hợp với lựa chọn hiện tại.')}</small>`;
    if (q.kind === 'one_time') return `<small class="price">Giá: <b>${vnd(q.total)}</b> trả một lần cho ${q.years} năm${priceWidgets ? ` (${priceWidgets} widget` : ''}${q.equivalentPerMonth ? `, ≈ ${vnd(q.equivalentPerMonth)}/tháng)` : priceWidgets ? ')' : ''}</small>`;
    return `<small class="price">Giá: <b>${vnd(q.total)}/tháng</b>${priceWidgets ? ` cho ${priceWidgets} widget` : ''} · ${vnd(q.perWidget)}/widget</small>`;
  }

  const PLANS = [
    { id: 'free', name: 'Miễn phí', widgets: 'tối đa 5 widget', retention: 'lịch sử 1 mẫu/2 giây, lưu 1 ngày', fit: 'Dùng thử, 1 trạm bơm nhỏ', ctl: true },
    { id: 'monitor', name: 'Cơ bản', widgets: 'tối đa 30 widget', retention: 'lịch sử 1 mẫu/10 giây, lưu 7 ngày', fit: 'Trạm bơm, xưởng nhỏ', ctl: true },
    { id: 'pro', name: 'Nâng cao', widgets: 'tối đa 100 widget', retention: 'lịch sử 1 mẫu/10 giây, lưu 30 ngày', fit: 'Xưởng vừa, nhiều trạm bơm, cần xem lại cả tháng', ctl: true },
    { id: 'factory', name: 'Nhà máy / partner', widgets: 'tối đa 300 widget', retention: 'lịch sử chi tiết 30 ngày, sau đó lưu 1 mẫu/5 phút đủ 10 năm; đăng ký một lần cho 10 năm', fit: 'Hệ thống lớn, cần lưu dài hạn', ctl: true },
  ];

  function reasonText(code) {
    if (code === 'widget_locked') {
      const lim = plan?.widgetLimit ?? sub?.widgetLimit ?? 5;
      const cnt = plan?.widgetCount;
      const lk = plan?.locked;
      return `Gói ${esc(plan?.label || sub?.planLabel || 'Miễn phí')} chỉ dùng được ${lim} widget.${cnt != null ? ` Tài khoản đang có ${cnt} widget nên ${lk} widget cuối bị làm mờ, không cập nhật dữ liệu và không điều khiển được.` : ' Các widget vượt giới hạn bị làm mờ, không cập nhật dữ liệu và không điều khiển được.'}`;
    }
    return esc(window.ErrText ? window.ErrText(code) : code);
  }

  function goUpgrade() {
    document.getElementById('plan-sheet')?.remove();
    if (typeof window.showTab === 'function') window.showTab('set');
    window.SettingsTabs?.show('plan');
    const p = document.getElementById('sub-panel');
    if (p) {
      p.hidden = false;
      setTimeout(() => { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); p.classList.add('plan-flash'); setTimeout(() => p.classList.remove('plan-flash'), 2200); }, 150);
    }
  }

  /** Mở khung chat và bộ chọn gói. KHÔNG tự gửi gì: chỉ gửi khi người dùng chọn gói rồi bấm "Gửi yêu cầu tư vấn". Không tạo đơn, không thanh toán. */
  function copyRequest() {
    document.getElementById('plan-sheet')?.remove();
    if (window.SupportChat) window.SupportChat.open();
  }

  function show(code) {
    document.getElementById('plan-sheet')?.remove();
    const locked = code === 'widget_locked';
    const el = document.createElement('div');
    el.id = 'plan-sheet'; el.className = 'cam-help';
    el.innerHTML = `<div class="sheet" role="dialog" aria-label="${locked ? 'Widget bị khoá' : 'Cần nâng gói'}">
      <h3>${locked ? '🔒 Widget bị khoá' : 'Chưa thực hiện được'}</h3>
      <p>${reasonText(code)}</p>
      <p class="note">Cách xử lý:</p>
      <ol>
        <li>Bấm <b>Xem gói</b> để mở mục Gói dịch vụ trong Cài đặt.</li>
        <li>Bấm <b>Chat để nâng cấp</b> để nhắn trực tiếp cho quản trị viên.</li>
        <li>Khi quản trị viên đã nâng gói, tải lại trang là dùng được ngay (không cần đăng nhập lại).</li>
        ${locked ? '<li>Hoặc gỡ bớt thiết bị để tổng số widget trong giới hạn của gói.</li>' : ''}
      </ol>
      <div class="row"><button type="button" class="primary" id="ps-up">Xem gói</button><button type="button" class="fit" id="ps-copy">Chat để nâng cấp</button><button type="button" class="fit" id="ps-close">Đóng</button></div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
    el.querySelector('#ps-close').onclick = () => el.remove();
    el.querySelector('#ps-up').onclick = goUpgrade;
    el.querySelector('#ps-copy').onclick = copyRequest;
  }

  function renderTable() {
    const host = document.getElementById('plan-table');
    if (!host) return;
    const cur = sub?.plan;
    host.innerHTML = PLANS.map((p) => `<div class="plan-row${p.id === cur ? ' cur' : ' pick'}" data-plan="${esc(p.id)}"${p.id === cur ? '' : ' role="button" tabindex="0"'}><b>${esc(p.name)}</b>${p.id === cur ? ' <span class="tag">đang dùng</span>' : ' <span class="tag pick-tag">chạm để chọn</span>'}
      <small>Có giám sát + điều khiển · ${esc(p.widgets)} · ${esc(p.retention)}</small>${priceLine(p.id)}<small class="fit">Phù hợp: ${esc(p.fit)}</small></div>`).join('');
    let box = document.getElementById('plan-days-box');
    if (!box) { box = document.createElement('div'); box.id = 'plan-days-box'; host.insertAdjacentElement('afterend', box); }
    box.innerHTML = `<label>Thời gian lưu lịch sử (gói Cơ bản / Nâng cao)<select id="plan-days">${DAYS.map((d) => `<option value="${d}"${d === days ? ' selected' : ''}>${d} ngày</option>`).join('')}</select></label>
      <p class="help">Giá chỉ để tham khảo, chưa phải đơn đặt hàng. Gói chỉ được kích hoạt sau khi bạn chat với quản trị viên và được xác nhận.</p>`;
    window.dispatchEvent(new Event('plan-table-rendered'));
  }

  /** Chạm vào một gói: chỉ chọn (✓), KHÔNG nhảy sang chat. Bấm "Chat để nâng cấp" mới mở chat với gói đã chọn. */
  function pickPlan(id) {
    if (!id || id === sub?.plan) return;
    window.SupportChat?.select?.(id);
  }
  document.addEventListener('click', (e) => { const r = e.target.closest?.('#plan-table .plan-row.pick'); if (r) pickPlan(r.dataset.plan); });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#plan-table .plan-row.pick')) { e.preventDefault(); pickPlan(e.target.dataset.plan); } });

  document.addEventListener('change', (e) => { if (e.target?.id === 'plan-days') { days = Number(e.target.value) || 30; loadPrices(); } });

  function update(s, p, name) {
    sub = s || sub; plan = p || plan; if (name) username = name;
    renderTable(); loadPrices();
    window.SupportChat?.fillPlans?.();   // bộ chọn gói trong chat: đánh dấu gói đang dùng
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('plan-copy')?.addEventListener('click', copyRequest);
    renderTable();
  });
  window.PlanUi = {
    show, goUpgrade, update, copyRequest,
    plans: PLANS,
    current: () => sub?.plan || 'free',
    currentLabel: () => sub?.planLabel || 'Miễn phí',
    username: () => username,
    selectedDays: () => days,
    setDays: (d) => { if (DAYS.includes(Number(d)) && Number(d) !== days) { days = Number(d); loadPrices(); } },
    allowedDays: DAYS,
    priceOf: (id) => ({ q: prices?.[id] || null, widgets: priceWidgets, days }),
    expiresAt: () => sub?.expiresAt || null,
  };
}());
