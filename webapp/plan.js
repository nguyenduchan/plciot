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

  const PLANS = [
    { id: 'free', name: 'Miễn phí', widgets: 'tối đa 5 widget', retention: 'lưu dữ liệu theo mặc định', ctl: true },
    { id: 'monitor', name: 'Giám sát', widgets: 'không giới hạn widget', retention: 'lưu dữ liệu theo mặc định', ctl: true },
    { id: 'pro', name: 'Giám sát + điều khiển', widgets: 'không giới hạn widget', retention: 'lưu 30 ngày', ctl: true },
    { id: 'factory', name: 'Nhà máy / đối tác', widgets: 'không giới hạn widget', retention: 'lưu không giới hạn', ctl: true },
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
    const p = document.getElementById('sub-panel');
    if (p) {
      p.hidden = false;
      setTimeout(() => { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); p.classList.add('plan-flash'); setTimeout(() => p.classList.remove('plan-flash'), 2200); }, 150);
    }
  }

  function requestText() {
    const cur = sub?.planLabel || 'Miễn phí';
    return `Xin chào, tôi muốn được tư vấn nâng cấp gói. Tài khoản: ${username || '(tên đăng nhập)'}, gói hiện tại: ${cur}.`;
  }

  /** Mở khung chat với quản trị viên, chỉ điền sẵn lời nhắn (người dùng tự bấm Gửi). Không tạo đơn, không thanh toán. */
  function copyRequest() {
    document.getElementById('plan-sheet')?.remove();
    if (typeof window.showTab === 'function') window.showTab('set');
    if (window.SupportChat) window.SupportChat.open(requestText());
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
    host.innerHTML = PLANS.map((p) => `<div class="plan-row${p.id === cur ? ' cur' : ''}"><b>${esc(p.name)}</b>${p.id === cur ? ' <span class="tag">đang dùng</span>' : ''}
      <small>Giám sát + điều khiển · ${esc(p.widgets)} · ${esc(p.retention)}</small></div>`).join('');
  }

  function update(s, p, name) {
    sub = s || sub; plan = p || plan; if (name) username = name;
    renderTable();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('plan-copy')?.addEventListener('click', copyRequest);
    renderTable();
  });
  window.PlanUi = { show, goUpgrade, update, copyRequest };
}());
