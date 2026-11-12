'use strict';
/* Trang kích hoạt gateway trên điện thoại: tạo mã ghép cặp → xem bản khai → duyệt → QR.
   BẮT BUỘC Face ID: server chỉ nhận /api/activate/* khi phiên điều khiển được mở bằng passkey; trang này chỉ là giao diện. */
(function () {
  const $ = (s) => document.querySelector(s);
  const Sec = window.Security;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch { /* chưa đăng nhập */ }
  if (!session?.token || session.demo) { location.replace('login.html'); return; }

  const ERR = {
    faceid_required: 'Cần mở khoá bằng Face ID / vân tay.',
    forbidden: 'Tài khoản này không phải admin.',
    unauthorized: 'Phiên đăng nhập hết hạn, đăng nhập lại.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    too_many_pairings: 'Đang có quá nhiều mã mở. Huỷ bớt mã cũ.',
    invalid_site_or_device: 'Site / mã tem chỉ gồm chữ, số, "_" và "-" (tối đa 48 ký tự).',
    site_device_taken: 'Site + mã tem này đã có gateway khác.',
    pairing_not_received: 'Gateway chưa gửi bản khai (hoặc mã đã hết hạn).',
    pairing_not_approved: 'Gateway này chưa được duyệt.',
    not_found: 'Không tìm thấy.',
    login_step_up_required: 'Cần đăng nhập lại.',
    offline: 'Không kết nối được máy chủ.',
    reauth_required: 'Cần xác thực lại: mở khoá Face ID lần nữa.',
    step_up_required: 'Cần xác thực lại: mở khoá Face ID lần nữa.',
  };
  const errText = (e) => ERR[e] || (e ? `Lỗi: ${e}` : 'Có lỗi xảy ra.');
  const api = (m, p, b) => Sec.api(m, p, b);
  const msg = (t, cls) => { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const STATUS = { open: 'chờ gateway nhập mã', received: 'chờ bạn duyệt', approved: 'đã kết nối' };

  let pollTimer = null; let tickTimer = null; let faceUntil = 0; let sites = []; let codeExp = 0;

  /* ---------- cổng Face ID ---------- */
  function showGate(text, help) {
    stopTimers();
    $('#app').hidden = true; $('#lock').hidden = true; $('#sess-left').textContent = '';
    $('#gate').hidden = false;
    if (text) $('#gate-text').textContent = text;
    $('#gate-help').innerHTML = help || '';
  }

  async function boot() {
    msg('');
    const st = await api('GET', '/api/activate/status');
    if (st.status === 404) { showGate('Chức năng kích hoạt đang tắt trên máy chủ.'); $('#gate-go').hidden = true; return; }
    if (st.status === 401) { location.replace('login.html'); return; }
    if (st.status === 403) { showGate('Tài khoản này không phải admin.'); $('#gate-go').hidden = true; return; }
    if (!st.ok) { showGate(errText(st.body?.error)); return; }
    $('#bypass').hidden = !st.body.bypass;
    if (st.body.faceId) { faceUntil = st.body.expiresAt || 0; showApp(); return; }
    showGate('Trang này chỉ mở được sau khi xác thực sinh trắc.');
  }

  async function unlockWithFaceId() {
    const cs = await api('GET', '/api/control/status');
    const m = cs.body?.methods;
    if (!m?.passkey) {
      showGate('Tài khoản admin chưa bật Face ID / vân tay.',
        'Mở <a href="index.html">ứng dụng</a> → Cài đặt → <b>Điều khiển &amp; xác thực</b> → thêm Face ID / vân tay (cần đúng thiết bị này), rồi quay lại trang này.');
      return;
    }
    // CHỈ passkey: không đưa TOTP / mật khẩu ra làm lựa chọn (server cũng từ chối phiên không phải passkey)
    const ok = await Sec.unlock({ methods: { passkey: true, totp: false, password: false, enrolled: true }, title: 'Face ID để vào trang kích hoạt' });
    if (ok === true) boot(); else msg('Chưa xác thực.', 'err');
  }

  /* ---------- ứng dụng ---------- */
  function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }

  function showApp() {
    $('#gate').hidden = true; $('#app').hidden = false; $('#lock').hidden = false;
    stopTimers();
    loadList();
    pollTimer = setInterval(() => { if (!document.hidden) loadList(); }, 4000);
    tickTimer = setInterval(tick, 1000); tick();
  }

  function tick() {
    const left = Math.max(0, Math.floor((faceUntil - Date.now()) / 1000));
    $('#sess-left').textContent = left ? `Face ID còn ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '';
    if (faceUntil && !left) showGate('Phiên Face ID đã hết hạn. Xác thực lại để tiếp tục.');
    if (codeExp) {
      const c = Math.max(0, Math.floor((codeExp - Date.now()) / 1000));
      $('#code-exp').textContent = c ? `Hết hạn sau ${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}` : 'Mã đã hết hạn';
    }
  }

  async function guarded(r) {
    if (r.status === 401 && ['faceid_required', 'step_up_required', 'reauth_required'].includes(r.body?.error)) {
      showGate('Phiên Face ID đã hết. Xác thực lại để tiếp tục.'); return false;
    }
    if (r.status === 401) { location.replace('login.html'); return false; }
    return true;
  }

  async function loadList() {
    const r = await api('GET', '/api/activate/pairings');
    if (!(await guarded(r))) return;
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    sites = r.body.sites || [];
    $('#sites').innerHTML = sites.map((x) => `<option value="${esc(x)}">`).join('');
    const open = document.activeElement?.closest?.('#list form');   // đang gõ thì không vẽ lại đè lên
    if (open) return;
    const items = r.body.pairings || [];
    $('#list').innerHTML = items.map((p) => `
      <div class="item ${p.status === 'received' ? 'rcv' : ''}" data-id="${esc(p.id)}">
        <b>${esc(p.label || p.id)}</b><span class="tag">${esc(STATUS[p.status] || p.status)}</span>
        <small>${p.status === 'approved' ? `✅ <code>${esc(p.site)}/${esc(p.device)}</code>` : `hết hạn ${fmtTime(p.expiresAt)}`}
          ${p.devices ? ` · ${p.devices} thiết bị` : ''}${p.fp ? ` · vân tay <code>${esc(p.fp)}</code>` : ''}${p.hw ? ` · ID máy <code>${esc(p.hw)}</code>` : ''}</small>
        <div class="row" style="margin-top:8px">
          ${p.status === 'received' ? '<button class="primary" data-act="review">Xem &amp; duyệt</button>' : ''}
          ${p.status === 'approved' ? '<button class="primary" data-act="qr">Hiện QR cho người dùng</button>' : ''}
          ${p.status === 'open' || p.status === 'received' ? '<button data-act="cancel" class="fit">Huỷ</button>' : ''}
        </div>
        <div class="review" hidden></div>
      </div>`).join('') || '<p class="help">Chưa có mã nào. Tạo mã ở bước 1, rồi nhập vào gateway.</p>';
  }

  async function review(id, host) {
    const r = await api('GET', `/api/activate/pairings/${encodeURIComponent(id)}`);
    if (!(await guarded(r))) return;
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    const p = r.body;
    const devs = (p.config || []).map((d) => `<div class="dev"><b>${esc(d.name)}</b> <code>${esc(d.id)}</code> — ${d.fields.length} giá trị${d.fields.some((f) => f.writable) ? ', có điều khiển' : ''}</div>`).join('')
      || '<div class="dev help">Gateway chưa khai thiết bị nào (có thể khai sau, tự đồng bộ).</div>';
    host.hidden = false;
    host.innerHTML = `
      <form autocomplete="off">
        <p class="help">Bản khai do gateway gửi, <b>chưa xác thực</b>. Đối chiếu vân tay / ID máy với màn hình GatewayApp trước khi duyệt.</p>
        ${devs}
        <label>Site (nhà máy)<input name="site" list="sites" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="demo_home" required></label>
        <datalist id="sites">${sites.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        <label>Mã tem gateway<input name="device" value="gw01" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label>Tên hiển thị<input name="name" value="${esc(p.label || '')}"></label>
        <label class="chk"><input type="checkbox" name="ok"><span>Vân tay <code>${esc(p.fp || '—')}</code> · ID máy <code>${esc(p.hw || '—')}</code> khớp với màn hình gateway</span></label>
        <div class="row"><button type="submit" class="primary" disabled>Duyệt &amp; tạo QR</button><button type="button" class="fit" data-act="close">Đóng</button></div>
      </form>`;
    const f = host.querySelector('form');
    const go = f.querySelector('button[type=submit]');
    f.ok.onchange = () => { go.disabled = !f.ok.checked; };
    f.querySelector('[data-act=close]').onclick = () => { host.hidden = true; host.innerHTML = ''; loadList(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const site = f.site.value.trim();
      if (!site) { msg('Nhập site (nhà máy).', 'err'); return; }
      go.disabled = true; msg('Đang duyệt…');
      const a = await api('POST', `/api/activate/pairings/${encodeURIComponent(id)}/approve`, { site, device: f.device.value.trim() || 'gw01', label: f.name.value.trim() });
      if (!(await guarded(a))) return;
      if (!a.ok) { msg(errText(a.body?.error), 'err'); go.disabled = !f.ok.checked; return; }
      msg('Đã duyệt. Đưa QR cho người lắp đặt.', 'ok');
      await loadList();
      showQr(a.body);
    };
  }

  async function showQr(b) {
    $('#qr-title').textContent = b.label || `${b.site}/${b.device}`;
    $('#qr-meta').textContent = `${b.site} / ${b.device}`;
    const host = $('#qr-canvas'); host.innerHTML = '';
    const canvas = document.createElement('canvas'); host.appendChild(canvas);
    const text = b.loginUrl || b.qr;
    if (window.QRCode?.toCanvas) await window.QRCode.toCanvas(canvas, text, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
    else host.innerHTML = `<p class="help">Không tải được thư viện QR. Link: <code>${esc(text)}</code></p>`;
    $('#qr-copy').onclick = async () => { try { await navigator.clipboard.writeText(text); msg('Đã sao chép link.', 'ok'); } catch { msg('Không sao chép được, hãy chép tay.', 'err'); } };
    const share = $('#qr-share');
    share.hidden = !navigator.share;
    share.onclick = () => navigator.share({ title: 'QR gateway', text }).catch(() => {});
    $('#qr-modal').classList.add('on');
  }
  const closeQr = () => { $('#qr-modal').classList.remove('on'); $('#qr-canvas').innerHTML = ''; };
  $('#qr-close').onclick = closeQr;

  /* ---------- sự kiện ---------- */
  $('#gate-go').onclick = unlockWithFaceId;
  $('#lock').onclick = async () => {
    try { await api('POST', '/api/control/lock', {}); } catch { /* bỏ qua */ }
    Sec.LS.del('ctl'); faceUntil = 0; showGate('Đã khoá. Xác thực Face ID để mở lại.');
  };

  $('#new').onclick = async () => {
    const b = $('#new'); b.disabled = true; msg('');
    const site = $('#site').value.trim();
    if (!site) { b.disabled = false; msg('Nhập site (nhà máy / trạm).', 'err'); return; }
    const r = await api('POST', '/api/activate/pairings', { label: $('#label').value.trim(), site, device: $('#device').value.trim() || undefined, auto: !$('#manual').checked });
    b.disabled = false;
    if (!(await guarded(r))) return;
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    $('#label').value = '';
    $('#code').textContent = r.body.code; codeExp = r.body.expiresAt;
    $('#code-box').hidden = false; tick();
    loadList();
  };
  $('#code-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#code').textContent); msg('Đã sao chép mã.', 'ok'); } catch { msg('Không sao chép được, hãy chép tay.', 'err'); }
  };

  $('#list').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('.item');
    if (!btn || !row) return;
    const id = row.dataset.id;
    if (btn.dataset.act === 'review') review(id, row.querySelector('.review'));
    else if (btn.dataset.act === 'qr') {
      const q = await api('GET', `/api/activate/pairings/${encodeURIComponent(id)}/qr`);
      if (!(await guarded(q))) return;
      if (!q.ok) { msg(errText(q.body?.error), 'err'); return; }
      showQr(q.body);
    }
    else if (btn.dataset.act === 'cancel') {
      if (!confirm('Huỷ mã ghép cặp này?')) return;
      const r = await api('DELETE', `/api/activate/pairings/${encodeURIComponent(id)}`);
      if (!(await guarded(r))) return;
      msg(r.ok ? 'Đã huỷ.' : errText(r.body?.error), r.ok ? 'ok' : 'err');
      loadList();
    }
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) loadList(); });
  boot();
})();
