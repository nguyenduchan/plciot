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
    if (!session?.token ) return;
    try {
      const r = await fetch(`${session.apiBase || location.origin}/api/support/prices?days=${days}`, { headers: { Authorization: `Bearer ${session.token}` } });
      if (!r.ok) return;
      const j = await r.json(); prices = j.prices; priceWidgets = j.widgets;
      if (Array.isArray(j.plans) && j.plans.length) PLANS = j.plans.map(toUiPlan);
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
    return `<small class="price">Giá: <b>${vnd(q.total)}/tháng</b>${q.perYear ? ` · trả cả năm ${vnd(q.perYear)}` : ''}</small>`;
  }

  // Danh sách gói đọc từ SERVER (cloud/app/config/plans.json) — không có số liệu gói trong app. name = "DK30 · Khởi đầu (Starter)": luôn kèm MÃ GÓI.
  let PLANS = [];
  const fmtMs = (ms) => (!ms ? '' : ms >= 60000 ? `${Math.round(ms / 60000)} phút` : `${Math.round(ms / 1000)} giây`);
  function toUiPlan(p) {
    const keep = p.unlimited ? 'đủ 10 năm' : `${p.retentionDays} ngày`;
    return {
      id: p.id, code: p.code, label: p.label, name: p.title || `${p.code} · ${p.label}`, desc: p.description, fit: p.audience, ctl: true,
      widgets: `${p.gateways != null ? p.gateways + ' gateway · ' : ''}tối đa ${p.devices != null ? p.devices : '∞'} thiết bị`,
      retention: `lưu lịch sử ${keep}${p.storeEveryMs ? `, ghi mỗi ${fmtMs(p.storeEveryMs)}` : ''}${p.exportDays ? `, xuất báo cáo ${p.exportDays} ngày gần nhất` : ', xuất báo cáo không giới hạn'}`,
      isFree: p.isFree,
    };
  }

  function reasonText(code) {
    if (code === 'widget_locked') {
      const lim = plan?.widgetLimit ?? sub?.widgetLimit ?? 5;
      const cnt = plan?.widgetCount;
      const lk = plan?.locked;
      return `Gói ${esc(plan?.label || sub?.planTitle || sub?.planLabel || 'Miễn phí')} chỉ dùng được ${plan?.deviceLimit != null ? plan.deviceLimit + ' thiết bị' : lim + ' widget'}.${cnt != null ? ` Tài khoản đang có ${cnt} widget nên ${lk} widget cuối bị làm mờ, không cập nhật dữ liệu và không điều khiển được.` : ' Các widget vượt giới hạn bị làm mờ, không cập nhật dữ liệu và không điều khiển được.'}`;
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
      <small>${esc(p.desc || '')}</small><small>Có giám sát + điều khiển · ${esc(p.widgets)} · ${esc(p.retention)}</small>${priceLine(p.id)}<small class="fit">Phù hợp: ${esc(p.fit)}</small></div>`).join('');
    let box = document.getElementById('plan-days-box');
    if (!box) { box = document.createElement('div'); box.id = 'plan-days-box'; host.insertAdjacentElement('afterend', box); }
    box.innerHTML = '<p class="help">Mã gói (DK10, DK30…) là số thiết bị tối đa của gói — dùng mã này khi trao đổi với quản trị viên. Giá chỉ để tham khảo, chưa phải đơn đặt hàng; gói chỉ được kích hoạt sau khi bạn chat với quản trị viên và được xác nhận.</p>';
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
    get plans() { return PLANS; },
    current: () => sub?.plan || 'free',
    currentLabel: () => sub?.planTitle || sub?.planLabel || 'Miễn phí',
    username: () => username,
    selectedDays: () => days,
    setDays: (d) => { if (DAYS.includes(Number(d)) && Number(d) !== days) { days = Number(d); loadPrices(); } },
    allowedDays: DAYS,
    priceOf: (id) => ({ q: prices?.[id] || null, widgets: priceWidgets, days }),
    expiresAt: () => sub?.expiresAt || null,
  };
}());
