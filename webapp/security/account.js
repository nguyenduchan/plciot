/* GENERATED từ packages/security/client/account.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';
/** Hồ sơ tài khoản — không còn SĐT / email / Telegram. */
(function () {
  const $ = (s) => document.querySelector(s);
  const session = () => { try { return JSON.parse(localStorage.getItem('session')); } catch { return null; } };
  if (!session()?.token || session()?.demo) return;

  function msg(text, bad) {
    const el = $('#acc-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('err', Boolean(bad));
  }

  async function load() {
    const root = $('#acc-sec');
    if (!root) return;
    root.hidden = false;
    const r = await window.Security.api('GET', '/api/account/security');
    if (!r.ok) { msg(window.Security.errText(r.body.error), true); return; }
    const sec = r.body;
    const box = $('#acc-summary');
    if (box) {
      box.innerHTML = [
        `Tài khoản: <b>${window.Security.escHtml(sec.username || session()?.username || '—')}</b>`,
        `Mật khẩu: ${sec.hasPassword ? 'đã đặt' : 'chưa đặt'}`,
        `Mã khôi phục còn: <b>${sec.recoveryCodesRemaining}</b>`,
      ].join('<br>');
    }
    ['#acc-phone', '#acc-email', '#pc-box', '#em-box'].forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = true;
    });
  }

  $('#acc-codes')?.addEventListener('click', async () => {
    msg('');
    const r = await window.Security.api('POST', '/api/account/recovery-codes', {});
    if (r.status === 401 && r.body.error === 'step_up_required' && window.Ctl) {
      if (await window.Ctl.unlock(r.body)) return $('#acc-codes').click();
    }
    if (!r.ok) return msg(window.Security.errText(r.body.error), true);
    const codes = (r.body.codes || []).join('\n');
    await window.Security.notice('Mã khôi phục mới', `Lưu các mã sau (mỗi mã dùng một lần):\n\n${codes}`);
    load();
  });

  load();
})();
