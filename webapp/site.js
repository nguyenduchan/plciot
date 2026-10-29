'use strict';
/* Cài đặt → "Nhà máy & thành viên": nhận thiết bị, mời/gỡ thành viên, ghép/thu hồi PC nhà máy. Không cần admin. */
(function () {
  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const session = LS.get('session', null);
  const root = $('#site-sec');
  if (!root || !session?.token || session.demo) return;
  root.hidden = false;

  const ERR = {
    not_site_owner: 'Chỉ chủ nhà máy mới làm được việc này.',
    site_taken: 'Nhà máy này đã có người dùng. Hãy nhờ chủ nhà máy mời bạn bằng số điện thoại.',
    device_offline: 'Chưa thấy thiết bị này gửi dữ liệu. Kiểm tra gateway đã bật và tên nhà máy / thiết bị.',
    invalid_site_or_device: 'Tên nhà máy / thiết bị không hợp lệ (chữ, số, - và _).',
    already_yours: 'Đây đã là nhà máy của bạn.',
    owner_has_members: 'Bạn đang là chủ một nhà máy có thành viên khác. Hãy gỡ họ trước.',
    claim_expired: 'Hết thời gian chờ. Bắt đầu lại.',
    same_phone: 'Không thể mời chính mình.',
    already_member: 'Số này đã là thành viên.',
    invalid_phone: 'Cần số di động Việt Nam hợp lệ.',
    invite_expired: 'Lời mời đã hết hạn.',
    cannot_remove_owner: 'Không gỡ được chủ nhà máy.',
    rate_limited: 'Thao tác quá nhiều, thử lại sau.',
    reauth_required: 'Để bảo mật, hãy đăng xuất rồi đăng nhập lại trước khi thực hiện thao tác này.',
    cancelled: 'Đã huỷ.',
  };
  const err = (d) => ERR[d.error] || (window.Ctl ? window.Ctl.errText(d.error) : d.error) || 'Lỗi';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN') : '—');
  const msg = (t, bad) => { const e = $('#site-msg'); e.textContent = t || ''; e.classList.toggle('err', Boolean(bad)); };

  async function call(method, path, body, retried) {
    const ctl = LS.get('ctl', null);
    const r = await fetch(`${session.apiBase || location.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json',
        ...(ctl?.token ? { 'X-Control-Token': ctl.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.error === 'step_up_required' && !retried && window.Ctl) {
      LS.del('ctl');
      if (await window.Ctl.unlock(data)) return call(method, path, body, true);
      return { ok: false, data: { error: 'cancelled' } };
    }
    if (r.status === 401 && ['session_revoked', 'unauthorized'].includes(data.error)) { LS.del('session'); location.replace('login.html?revoked=1'); }
    return { ok: r.ok, data };
  }

  /* ---------- hộp thoại mã ghép PC ---------- */
  function pairModal(code, expiresIn) {
    const wrap = document.createElement('div');
    wrap.className = 'ctl-modal';
    wrap.innerHTML = `<div class="ctl-box"><h3>Ghép PC nhà máy</h3>
      <p class="muted">Mở phần mềm SCADA trên PC cần ghép → <b>Kết nối cloud → Ghép cặp</b> và nhập mã này. Mã dùng một lần, còn <b class="left">${expiresIn}</b> giây.</p>
      <pre class="codes" style="font-size:26px;text-align:center">${esc(code)}</pre>
      <div class="row"><button class="fit close">Đóng</button></div></div>`;
    document.body.appendChild(wrap);
    let left = expiresIn;
    const t = setInterval(() => { left--; const e = wrap.querySelector('.left'); if (e) e.textContent = String(Math.max(left, 0)); if (left <= 0) close(); }, 1000);
    function close() { clearInterval(t); wrap.remove(); load(); }
    wrap.querySelector('.close').onclick = close;
  }

  /* ---------- nhận thiết bị ---------- */
  async function claimFlow(site, device) {
    msg('');
    const s = await call('POST', '/api/site/claim/start', { site, device });
    if (!s.ok) return msg(err(s.data), true);
    const box = $('#site-claim-status');
    box.hidden = false;
    let left = s.data.expiresIn;
    box.innerHTML = `Để chứng minh bạn đang ở cạnh PLC: <b>bật rồi tắt ngõ vào X${s.data.bit}</b> trong <b id="site-left">${left}</b> giây.`;
    while (left > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      left -= 2; const el = $('#site-left'); if (el) el.textContent = String(Math.max(left, 0));
      const c = await call('POST', '/api/site/claim/check', {});
      if (!c.ok) { box.hidden = true; return msg(err(c.data), true); }
      if (c.data.claimed) { msg('Đã nhận thiết bị. Đang tải lại…'); return setTimeout(() => location.reload(), 800); }
    }
    box.hidden = true;
    msg(ERR.claim_expired, true);
  }

  async function load() {
    const r = await call('GET', '/api/site');
    const body = $('#site-body');
    if (!r.ok) { body.textContent = err(r.data); return; }
    const d = r.data;
    let h = `<p>Nhà máy: <b>${esc(d.site)}/${esc(d.device)}</b> ${d.online ? '🟢 đang kết nối' : '⚪ chưa thấy dữ liệu'} · ${d.isOwner ? 'bạn là <b>chủ</b>' : `quyền <b>${d.role === 'viewer' ? 'chỉ xem' : 'điều khiển'}</b>`} · ${d.memberCount} người dùng</p>`;

    if (d.invitesIn.length) {
      h += `<h4>Lời mời dành cho bạn</h4>${d.invitesIn.map((i) => `<div class="pend">${esc(i.from)} mời bạn vào <b>${esc(i.site)}/${esc(i.device)}</b> (${i.role === 'viewer' ? 'chỉ xem' : 'điều khiển'}).
        <div class="row"><button class="primary" data-acc="${i.id}">Chấp nhận</button><button class="fit" data-dec="${i.id}">Từ chối</button></div>
        <div class="muted">Chấp nhận sẽ chuyển tài khoản sang nhà máy đó.</div></div>`).join('')}`;
    }

    if (d.isOwner) {
      h += `<h4>Thành viên</h4>${d.members.map((m) => `<div class="row" style="align-items:center"><span style="flex:1">${esc(m.phone)} · ${m.owner ? 'chủ' : (m.role === 'viewer' ? 'chỉ xem' : 'điều khiển')}${m.me ? ' (bạn)' : ''}</span>${m.owner ? '' : `<button class="fit" data-rm="${m.id}">Gỡ</button>`}</div>`).join('')}`;
      h += d.invitesOut.map((i) => `<div class="row" style="align-items:center"><span style="flex:1" class="muted">Đã mời ${esc(i.phone)} (${i.role === 'viewer' ? 'chỉ xem' : 'điều khiển'}), hết hạn ${fmt(i.expiresAt)}</span><button class="fit" data-ci="${i.id}">Huỷ</button></div>`).join('');
      h += `<div class="row" style="margin-top:8px"><input id="inv-phone" inputmode="tel" placeholder="SĐT người được mời" style="flex:1"><select id="inv-role" style="max-width:130px"><option value="operator">Điều khiển</option><option value="viewer">Chỉ xem</option></select></div>
        <div class="row"><button id="inv-go" class="primary">Mời thành viên</button></div>`;
      h += `<h4>PC nhà máy</h4>${d.stations.length ? d.stations.map((s) => `<div class="row" style="align-items:center"><span style="flex:1">🖥 ${esc(s.name)}<br><span class="muted">${s.lastSeenAt ? `thấy lần cuối ${fmt(s.lastSeenAt)}${s.ip ? ` · ${esc(s.ip)}` : ''}` : 'chưa kết nối'}</span></span><button class="fit danger" data-pc="${s.id}">Thu hồi</button></div>`).join('') : '<p class="muted">Chưa có PC nào được ghép.</p>'}
        <div class="row"><button id="pc-add" class="primary">Thêm PC (lấy mã ghép)</button></div>
        <p class="muted">Đổi PC: thêm PC mới rồi thu hồi PC cũ. PC bị thu hồi mất quyền ngay.</p>`;
    } else {
      h += `<h4>Nhận thiết bị mới</h4><p class="muted">Nếu nhà máy của bạn chưa có ai dùng: nhập tên nhà máy / thiết bị in trên gateway rồi xác nhận bằng cách tác động vào ngõ vào PLC. Nếu đã có người dùng, hãy nhờ chủ nhà máy mời bạn.</p>
        <div class="row"><input id="claim-site" placeholder="Tên nhà máy (site)" style="flex:1"><input id="claim-dev" placeholder="Thiết bị" value="plc01" style="max-width:110px"></div>
        <div class="row"><button id="claim-go" class="primary">Nhận thiết bị</button></div><p id="site-claim-status" class="pend" hidden></p>`;
    }
    body.innerHTML = h;

    body.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = async () => { const x = await call('POST', `/api/invites/${b.dataset.acc}/accept`, {}); if (x.ok) { msg('Đã vào nhà máy. Đang tải lại…'); setTimeout(() => location.reload(), 800); } else msg(err(x.data), true); }; });
    body.querySelectorAll('[data-dec]').forEach((b) => { b.onclick = async () => { await call('POST', `/api/invites/${b.dataset.dec}/decline`, {}); load(); }; });
    body.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { if (!confirm('Gỡ thành viên này khỏi nhà máy?')) return; const x = await call('DELETE', `/api/site/members/${b.dataset.rm}`); msg(x.ok ? 'Đã gỡ.' : err(x.data), !x.ok); load(); }; });
    body.querySelectorAll('[data-ci]').forEach((b) => { b.onclick = async () => { await call('DELETE', `/api/site/invites/${b.dataset.ci}`); load(); }; });
    body.querySelectorAll('[data-pc]').forEach((b) => { b.onclick = async () => { if (!confirm('Thu hồi PC này? Nó sẽ mất quyền ngay.')) return; const x = await call('DELETE', `/api/site/stations/${b.dataset.pc}`); msg(x.ok ? 'Đã thu hồi PC.' : err(x.data), !x.ok); load(); }; });
    const inv = $('#inv-go');
    if (inv) inv.onclick = async () => {
      const x = await call('POST', '/api/site/invites', { phone: $('#inv-phone').value.trim(), role: $('#inv-role').value });
      msg(x.ok ? 'Đã gửi lời mời (hiệu lực 7 ngày). Người được mời đăng nhập và bấm Chấp nhận.' : err(x.data), !x.ok);
      if (x.ok) load();
    };
    const pc = $('#pc-add');
    if (pc) pc.onclick = async () => {
      const x = await call('POST', '/api/site/pair-code', { name: 'PC nhà máy' });
      if (!x.ok) return msg(err(x.data), true);
      pairModal(x.data.code, x.data.expiresIn);
    };
    const cg = $('#claim-go');
    if (cg) cg.onclick = () => claimFlow($('#claim-site').value.trim(), $('#claim-dev').value.trim() || 'plc01');
  }

  load();
}());
