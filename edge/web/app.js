'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'scada' };
  const R = { MODE: 3, MAN: 4, RUN: 6, TGT: 7, RESET: 9 };
  let S = null, tab = 'mon';

  const ERR = {
    invalid_credentials: 'Sai tài khoản hoặc mật khẩu.',
    rate_limited: 'Sai quá nhiều lần, thử lại sau vài phút.',
    forbidden: 'Tài khoản chỉ xem, không được điều khiển.',
    not_writable: 'Thanh ghi này không được phép ghi.',
  };

  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: H, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(ERR[j.error] || j.error || 'Lỗi ' + r.status);
    return j;
  }

  const pill = (el, text, cls) => { el.textContent = text; el.className = 'pill ' + (cls || ''); };
  const hms = (s) => `${Math.floor(s / 3600)} giờ ${String(Math.floor(s / 60) % 60).padStart(2, '0')} phút`;
  const led = (on, name) => `<span class="led ${on ? 'on' : ''}"><i></i>${name}</span>`;
  const bits = (v, p) => [...Array(8).keys()].map((i) => led(v >> i & 1, p + i)).join('');

  function render() {
    if (!S) return;
    $('#title').textContent = `SCADA · ${S.site}/${S.device}`;
    const online = S.status === 'online' && S.fresh;
    pill($('#p-plc'), online ? 'PLC online' : S.status === 'plc_fault' ? 'PLC lỗi' : 'PLC mất kết nối', online ? 'on' : 'bad');
    pill($('#p-cloud'), { connected: 'Cloud ✓', connecting: 'Cloud…', disconnected: 'Cloud ✗', disabled: 'Cloud tắt' }[S.cloud] || S.cloud,
      S.cloud === 'connected' ? 'on' : S.cloud === 'disabled' ? '' : 'warn');
    pill($('#p-role'), S.role === 'operator' ? S.user + ' · điều khiển' : S.user + ' · chỉ xem');

    $('#k-conv').textContent = S.conveyorText;
    $('#k-count').textContent = `${S.count} / ${S.target || '∞'}`;
    $('#k-total').textContent = S.total;
    $('#k-run').textContent = hms(S.runSeconds);
    $('#k-mode').textContent = S.manual ? 'Thủ công' : 'Tự động';
    $('#k-pump').textContent = S.pumpStarts;
    $('#alarms').innerHTML = led(S.alarms & 1, 'E-stop') + led(S.alarms & 2, 'Lỗi cảm biến mức');
    $('#xs').innerHTML = bits(S.inputs, 'X');
    $('#ys').innerHTML = bits(S.outputs, 'Y');
    $('#sys').textContent = `Thiết bị LAN đang nối: ${S.localClients} · Điều khiển từ xa (điện thoại): ${S.remoteAllowed ? 'BẬT' : 'TẮT'}`;

    const ctl = S.role === 'operator' && online;
    $('#ctl-hint').textContent = S.role !== 'operator' ? 'Tài khoản chỉ xem. Đăng nhập tài khoản điều khiển để ghi lệnh.'
      : online ? 'Khoá liên động an toàn (E-stop, đủ số lượng) luôn do PLC quyết định.' : 'PLC chưa sẵn sàng.';
    ['#m-auto', '#m-man', '#c-start', '#c-stop', '#c-set', '#c-reset'].forEach((s) => { $(s).disabled = !ctl; });
    $('#m-auto').classList.toggle('pri', !S.manual); $('#m-man').classList.toggle('pri', S.manual);
    $('#c-start').disabled = !ctl || S.runRequested; $('#c-stop').disabled = !ctl || !S.runRequested;
    $('#sw').innerHTML = [...Array(8).keys()].map((i) =>
      `<button class="b sw ${S.manualMask >> i & 1 ? 'on' : ''}" data-i="${i}" ${ctl && S.manual && i !== 1 ? '' : 'disabled'}>Y${i}</button>`).join('');
    if (document.activeElement !== $('#tgt')) $('#tgt').value = S.target;
    $('#ack').textContent = S.lastAck ? 'Phản hồi cuối: ' + S.lastAck : '';
    if (tab === 'rep') drawChart();
  }

  async function send(a, v) {
    try { await api('/scada/api/cmd', 'POST', { a, v }); } catch (e) { $('#ack').textContent = e.message; }
  }

  function drawChart() {
    const cv = $('#cv'), h = S.history;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const w = cv.clientWidth, ht = cv.clientHeight;
    g.clearRect(0, 0, w, ht);
    if (!h) { $('#rep-info').textContent = 'Chưa nhận lịch sử giờ từ PLC.'; return; }
    const vals = h.c.slice(0, 49).reverse();                  // cũ → mới; phần tử cuối là giờ hiện tại
    const max = Math.max(1, ...vals);
    const bw = w / vals.length;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--acc') || '#0f766e';
    vals.forEach((v, i) => { const bh = (v / max) * (ht - 20); g.fillRect(i * bw + 1, ht - bh - 4, bw - 2, bh); });
    $('#rep-info').textContent = `Cao nhất ${max} sản phẩm/giờ · đã ghi ${h.n} giờ · giờ hiện tại: ${vals[vals.length - 1]} (${Math.floor(h.s / 60)} phút)`;
  }

  async function loadLog() { try { $('#logtxt').textContent = (await api('/scada/api/log')).join('\n') || '(trống)'; } catch { /* ignore */ } }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('nav button');
    if (t) {
      tab = t.dataset.t;
      document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b === t));
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 't-' + tab));
      if (tab === 'log') loadLog();
      if (tab === 'rep') drawChart();
    }
    const sw = e.target.closest('#sw .sw');
    if (sw && !sw.disabled) send(R.MAN, S.manualMask ^ (1 << +sw.dataset.i));
  });
  $('#m-auto').onclick = () => send(R.MODE, 0);
  $('#m-man').onclick = () => send(R.MODE, 1);
  $('#c-start').onclick = () => send(R.RUN, 1);
  $('#c-stop').onclick = () => send(R.RUN, 0);
  $('#c-set').onclick = () => { const v = parseInt($('#tgt').value || '0', 10); if (v >= 0 && v <= 65535) send(R.TGT, v); };
  $('#c-reset').onclick = () => { if (confirm('Xoá số đếm hiện tại về 0?')) send(R.RESET, 1); };
  async function poll() {
    try { S = await api('/scada/api/state'); render(); } catch { /* mất mạng: thử lại */ }
  }
  poll(); setInterval(poll, 1000);
})();
