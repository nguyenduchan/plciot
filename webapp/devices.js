'use strict';
/**
 * Dashboard thiết bị theo UI contract (GET /api/v1/ui/dashboard).
 * Thêm thiết bị: quét/dán QR → server tự chọn type/widget.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let dashboard = null;
  const live = {}; // childId → { key: value }

  function session() {
    return LS.get('session', null);
  }

  async function api(method, path, body) {
    const s = session();
    if (!s?.token || s.demo) return { ok: false, data: { error: 'unauthorized' } };
    const r = await fetch(`${s.apiBase || location.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        'Content-Type': 'application/json',
        ...(LS.get('ctl', null)?.token ? { 'X-Control-Token': LS.get('ctl').token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function toast(msg, bad) {
    if (window.toast) return window.toast(msg, bad);
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', Boolean(bad));
    t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 3200);
  }

  function val(childId, bind) {
    const o = live[childId];
    if (!o) return null;
    return o[bind];
  }

  function widgetHtml(dev, w) {
    const v = val(dev.childId, w.bind);
    const show = v == null || v === '' ? '—' : v;
    const unit = w.unit ? ` <small>${esc(w.unit)}</small>` : '';
    if (w.kind === 'gauge') {
      const min = Number(w.min ?? 0); const max = Number(w.max ?? 100);
      const n = Number(v);
      const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, ((n - min) / (max - min || 1)) * 100)) : 0;
      return `<div class="dw gauge" data-wid="${esc(w.id)}"><div class="k">${esc(w.label)}</div>
        <div class="gauge-bar"><i style="width:${pct}%"></i></div>
        <div class="v">${esc(show)}${unit}</div></div>`;
    }
    if (w.kind === 'ring') {
      const pct = Math.max(0, Math.min(100, Number(v) || 0));
      return `<div class="dw ringw" data-wid="${esc(w.id)}"><div class="ring" style="--p:${pct}"><span>${esc(show)}${v != null ? '%' : ''}</span></div>
        <div class="k">${esc(w.label)}</div></div>`;
    }
    if (w.kind === 'toggle') {
      const on = Number(v) === 1 || v === true;
      const c = w.cmd || {};
      // ★ = lệnh nguy hiểm: mỗi lần phải xác nhận (Face ID / Authenticator / mật khẩu). Tem có thể đặt sẵn (khoá, không bỏ được).
      const star = c.key != null
        ? `<button type="button" class="dw-star ${c.critical ? 'on' : ''}" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}" data-key="${esc(c.key)}" data-crit="${c.critical ? 1 : 0}" ${c.criticalLocked ? 'disabled' : ''} title="${c.critical ? (c.criticalLocked ? 'Lệnh nguy hiểm do tem đặt' : 'Bỏ đánh dấu nguy hiểm') : 'Đánh dấu lệnh nguy hiểm'}">${c.critical ? '★' : '☆'}</button>`
        : '';
      const info = [c.critical ? `⚠ Nguy hiểm — xác nhận từng lần${c.criticalLocked ? ' (tem đặt)' : ''}` : '', c.limits ? `Giới hạn ${c.limits.min}–${c.limits.max}` : ''].filter(Boolean).join(' · ');
      return `<div class="dw ctlw ${c.critical ? 'crit' : ''}" data-wid="${esc(w.id)}"><div class="k">${esc(w.label)} ${star}</div>
        <button type="button" class="fit dw-toggle ${on ? 'on' : ''}" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}">${on ? '● Bật' : '○ Tắt'}</button>${info ? `<div class="d muted dw-info">${esc(info)}</div>` : ''}</div>`;
    }
    if (w.kind === 'status' || w.kind === 'chip') {
      const on = Number(v) === 1 || v === true || (typeof v === 'number' && v > 0);
      return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${esc(w.label)}</div>
        <div class="chip ${on ? 'on' : ''}">${esc(String(show))}</div></div>`;
    }
    if (w.kind === 'sparkline' || w.kind === 'line' || w.kind === 'bar') {
      return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${esc(w.label)}</div>
        <div class="v">${esc(show)}${unit}</div><div class="d muted">biểu đồ live</div></div>`;
    }
    // kpi / text / default
    return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${esc(w.label)}</div>
      <div class="v">${esc(show)}${unit}</div></div>`;
  }

  function render() {
    const host = $('#dev-grid');
    if (!host) return;
    if (!dashboard?.devices?.length) {
      host.innerHTML = `<div class="dev-empty muted">Chưa có thiết bị.<br>Bấm <b>+ Thêm</b>, dán/quét QR tem — widget tự hiện (không cần sơ đồ SCADA).</div>`;
      return;
    }
    const order = dashboard.layout?.simple?.order || dashboard.devices.map((d) => d.id);
    const byId = Object.fromEntries(dashboard.devices.map((d) => [d.id, d]));
    host.innerHTML = order.map((id) => {
      const d = byId[id];
      if (!d) return '';
      return `<article class="dev-card" data-id="${esc(d.id)}" data-child="${esc(d.childId)}" data-type="${esc(d.type)}">
        <header><h3>${esc(d.title)}</h3><span class="muted">${esc(d.type)}</span>
          <button type="button" class="fit danger dw-rm" data-id="${esc(d.id)}" title="Gỡ">×</button></header>
        <div class="dev-widgets">${d.widgets.map((w) => widgetHtml(d, w)).join('')}</div>
      </article>`;
    }).join('');

    host.querySelectorAll('.dw-rm').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Gỡ thiết bị khỏi dashboard?')) return;
        const r = await api('DELETE', `/api/devices/${b.dataset.id}`);
        if (!r.ok) return toast(r.data.error || 'Lỗi', true);
        await load();
      };
    });
    host.querySelectorAll('.dw-star').forEach((b) => {
      b.onclick = async () => {
        const want = b.dataset.crit !== '1';
        let r = await api('POST', `/api/devices/${b.dataset.dev}/critical`, { key: b.dataset.key, critical: want });
        if (r.status === 401 && r.data?.error === 'step_up_required' && window.Ctl?.unlock && await window.Ctl.unlock(r.data)) {
          r = await api('POST', `/api/devices/${b.dataset.dev}/critical`, { key: b.dataset.key, critical: want });
        }
        if (!r.ok) return toast({ locked_by_provisioning: 'Do tem đặt — không bỏ được.', step_up_required: 'Cần xác thực để bỏ đánh dấu.' }[r.data?.error] || r.data?.error || 'Lỗi', true);
        dashboard = r.data.dashboard; render();
        toast(want ? 'Đã đánh dấu lệnh nguy hiểm: mỗi lần sẽ phải xác nhận.' : 'Đã bỏ đánh dấu.');
      };
    });
    host.querySelectorAll('.dw-toggle').forEach((b) => {
      b.onclick = () => {
        const dev = dashboard.devices.find((x) => x.id === b.dataset.dev);
        const w = dev?.widgets?.find((x) => x.id === b.dataset.wid);
        if (!w?.cmd) return;
        const cur = Number(val(dev.childId, w.bind)) === 1;
        const next = cur ? (w.cmd.off ?? 0) : (w.cmd.on ?? 1);
        if (typeof window.command === 'function' && w.cmd.a != null) {
          window.command(w.cmd.a, next);
        } else if (w.cmd.key != null && window.Ctl?.send) {
          // thiết bị con của hub: lệnh {child,key,v} đi /api/control/cmd (cùng xác thực bước hai), kết quả thật hiện qua telemetry
          b.disabled = true;
          // cập nhật lạc quan: nút đổi ngay, telemetry của PLC xác nhận (hoặc sửa lại) sau; lỗi thì trả về giá trị cũ
          const prev = live[dev.childId]?.[w.bind];
          live[dev.childId] = { ...live[dev.childId], [w.bind]: next };
          render();
          window.Ctl.send({ child: dev.childId, key: w.cmd.key, v: next }).then((r) => {
            if (r?.ok) return toast('Đã gửi lệnh tới thiết bị.');
            live[dev.childId] = { ...live[dev.childId], [w.bind]: prev };
            render();
            const msg = { cancelled: 'Đã huỷ.', app_locked: 'Ứng dụng đang khoá.', session_expired: 'Phiên hết hạn — đăng nhập lại.', enroll_required: 'Cần bật vân tay / Authenticator trong tab Điều khiển.' }[r?.error] || r?.error || 'Gửi lệnh lỗi';
            toast(msg, true);
          }).finally(() => { b.disabled = false; });
        } else {
          live[dev.childId] = { ...live[dev.childId], [w.bind]: next };
          render();
          toast('Đã gửi (demo/local)');
        }
      };
    });
  }

  async function load() {
    const s = session();
    if (!s?.token || s.demo) {
      dashboard = { devices: [], layout: { simple: { order: [] } } };
      render();
      return;
    }
    const mode = (LS.get('cfg', {})?.uiMode === 'pro') ? 'pro' : 'simple';
    const r = await api('GET', `/api/v1/ui/dashboard?mode=${mode}`);
    if (!r.ok) {
      dashboard = { devices: [] };
      render();
      return;
    }
    dashboard = r.data;
    render();
  }

  function openModal() {
    const m = $('#dev-modal');
    if (!m) return;
    m.hidden = false;
    $('#dev-qr')?.focus();
  }
  function closeModal() {
    stopCamera();
    const m = $('#dev-modal');
    if (m) m.hidden = true;
  }

  // ---- Đọc QR từ ảnh / camera ------------------------------------------------------------
  // Dùng BarcodeDetector (Chrome/Edge/Android). Nếu có thêm vendor/jsQR.js (tuỳ chọn) thì dùng làm dự phòng cho Safari/Firefox.
  let camStream = null; let camTimer = null;

  async function loadJsQr() {
    if (window.jsQR) return window.jsQR;
    await new Promise((ok) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js'; s.onload = ok; s.onerror = ok;
      document.head.appendChild(s);
    });
    return window.jsQR || null;
  }

  /** source: ImageBitmap | HTMLVideoElement | HTMLImageElement → chuỗi QR hoặc null. */
  async function decodeQr(source) {
    if ('BarcodeDetector' in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        const r = await det.detect(source);
        if (r[0]?.rawValue) return r[0].rawValue;
        return null;
      } catch { /* thử jsQR */ }
    }
    const jsqr = await loadJsQr();
    if (!jsqr) throw new Error('no_decoder');
    const w = source.videoWidth || source.width; const h = source.videoHeight || source.height;
    if (!w || !h) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return jsqr(img.data, w, h)?.data || null;
  }

  function gotQr(text) {
    const ta = $('#dev-qr');
    if (ta) ta.value = text.trim();
    submitQr();
  }

  async function pickImage(file) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const text = await decodeQr(bmp);
      if (bmp.close) bmp.close();
      if (!text) return toast('Không đọc được mã QR trong ảnh.', true);
      gotQr(text);
    } catch (e) {
      toast(e.message === 'no_decoder' ? 'Trình duyệt này chưa hỗ trợ đọc QR từ ảnh — hãy dán chuỗi QR.' : 'Không đọc được ảnh.', true);
    }
  }

  function stopCamera() {
    if (camTimer) { clearInterval(camTimer); camTimer = null; }
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    const v = $('#dev-video'); if (v) v.srcObject = null;
    const box = $('#dev-cam'); if (box) box.hidden = true;
    const b = $('#dev-scan'); if (b) b.textContent = '📷 Quét camera';
  }

  async function toggleCamera() {
    if (camStream) return stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) return toast('Trình duyệt không hỗ trợ camera (cần HTTPS).', true);
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch {
      return toast('Không mở được camera — hãy cho phép quyền camera cho trang này.', true);
    }
    const v = $('#dev-video');
    v.srcObject = camStream;
    await v.play().catch(() => {});
    $('#dev-cam').hidden = false;
    $('#dev-scan').textContent = '✕ Tắt camera';
    let busy = false;
    camTimer = setInterval(async () => {
      if (busy || !camStream) return;
      busy = true;
      try {
        const text = await decodeQr(v);
        if (text) { stopCamera(); gotQr(text); }
      } catch (e) {
        if (e.message === 'no_decoder') { stopCamera(); toast('Trình duyệt này chưa hỗ trợ quét QR — hãy chọn ảnh hoặc dán chuỗi QR.', true); }
      } finally { busy = false; }
    }, 300);
  }

  async function submitQr() {
    const qr = ($('#dev-qr')?.value || '').trim();
    if (!qr) return toast('Dán chuỗi QR từ tem thiết bị.', true);
    const btn = $('#dev-add-go');
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/devices', { qr });
      if (!r.ok) {
        const err = {
          unknown_profile: 'Tem chưa gắn loại thiết bị trên máy chủ.',
          site_mismatch: 'Tem thuộc nhà máy khác.',
          device_already_claimed: 'Tem đã có chủ khác.',
          unknown_device: 'Tem chưa đăng ký trên máy chủ.',
          invalid_claim_signature: 'Mã QR không xác thực được.',
        }[r.data.error] || r.data.error || 'Không thêm được';
        return toast(err, true);
      }
      closeModal();
      if ($('#dev-qr')) $('#dev-qr').value = '';
      const n = r.data.added?.length || 0;
      toast(n ? `Đã thêm ${n} thiết bị — giao diện tự dựng.` : 'Đã cập nhật.');
      if (r.data.dashboard) {
        dashboard = r.data.dashboard;
        render();
      } else await load();
      // Đồng bộ site/dev cfg nếu server đổi gateway
      if (window.applySiteFromDevices) await window.applySiteFromDevices(r.data.site, r.data.gateway);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** MQTT: monitor từ d.*; conveyor legacy r[] vẫn đọc được. Type/UI từ dashboard server. */
  function onTelemetry(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.d && typeof payload.d === 'object') {
      for (const [childId, obj] of Object.entries(payload.d)) {
        if (obj && typeof obj === 'object') live[childId] = { ...live[childId], ...obj };
      }
    }
    if (Array.isArray(payload.r) && dashboard?.devices) {
      for (const d of dashboard.devices) {
        if (d.type !== 'conveyor') continue;
        const r = payload.r;
        const count = (r[14] || 0) + (r[15] || 0) * 65536;
        live[d.childId] = {
          ...live[d.childId],
          count,
          runReq: r[6] || 0,
          runPct: r[8] === 1 ? 100 : 0,
          speed: 0,
        };
      }
    }
    render();
  }

  function injectDemoLive() {
    if (!dashboard?.devices?.length) return;
    for (const d of dashboard.devices) {
      if (d.type === 'env') {
        live[d.childId] = { t: 26 + Math.random() * 4, h: 55 + Math.random() * 10 };
      } else if (d.type === 'pump') {
        live[d.childId] = { run: 1, hours: 12.4, flow: 30 + Math.random() * 20 };
      } else if (d.type === 'switch' || d.type === 'relay') {
        live[d.childId] = { on: live[d.childId]?.on ?? 0 };
      } else if (d.type === 'energy') {
        live[d.childId] = { kw: 1.2 + Math.random(), kwh: 340 };
      } else if (d.type === 'tank') {
        live[d.childId] = { level: 40 + Math.random() * 40 };
      } else if (d.type === 'motor') {
        live[d.childId] = { run: 1, rpm: 1400 };
      }
    }
    render();
  }

  window.DevicesUi = { load, onTelemetry, injectDemoLive, openModal, getDashboard: () => dashboard };

  document.addEventListener('DOMContentLoaded', () => {
    $('#dev-add')?.addEventListener('click', openModal);
    $('#dev-modal-close')?.addEventListener('click', closeModal);
    $('#dev-add-go')?.addEventListener('click', submitQr);
    $('#dev-scan')?.addEventListener('click', toggleCamera);
    $('#dev-pick')?.addEventListener('click', () => $('#dev-file')?.click());
    $('#dev-file')?.addEventListener('change', (e) => { pickImage(e.target.files?.[0]); e.target.value = ''; });
    $('#dev-modal')?.addEventListener('click', (e) => { if (e.target.id === 'dev-modal') closeModal(); });
    load();
  });
}());
