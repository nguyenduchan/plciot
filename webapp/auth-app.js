'use strict';
/* Trang đăng nhập dùng cùng bảng màu với app: kiểu "Đơn giản" (mặc định) trừ khi người dùng đã chọn kiểu Vận hành. */
(function () {
  let pro = false;
  try { pro = (JSON.parse(localStorage.getItem('cfg')) || {}).uiMode === 'pro'; } catch {}
  const apply = () => document.body && document.body.classList.toggle('ui-simple', !pro);
  if (document.body) apply(); else document.addEventListener('DOMContentLoaded', apply);
}());
window.AuthApp = {
  contactLabel: 'Xác minh thiết bị',
  presenceHint: (state, seconds) => `Hãy kích hoạt đầu vào X${state.plcBit} trên PLC trong ${seconds} giây.`,
  onAuthConfig() {},
  onAuthenticated(data) {
    let cfg;
    try { cfg = JSON.parse(localStorage.getItem('cfg')) || {}; } catch { cfg = {}; }
    if (data.mqtt) {
      Object.assign(cfg, { user: data.mqtt.user, pass: data.mqtt.pass, site: data.mqtt.site, dev: data.mqtt.device, controlVia: data.mqtt.controlVia || 'mqtt' });
    } else if (data.notifySite) Object.assign(cfg, { site: data.notifySite, dev: data.notifyDevice });
    localStorage.setItem('cfg', JSON.stringify(cfg));
  },
  onSecuritySummary(summary) {
    const retention = document.querySelector('#ret-info');
    if (retention) retention.textContent = summary.unlimited ? 'Lưu dữ liệu không giới hạn thời gian.' : `Lưu dữ liệu ${summary.retentionDays} ngày.`;
    const privacy = document.querySelector('#privacy-info');
    if (privacy) {
      const p = summary.privacy || {};
      const dpo = [summary.dpoContact, summary.dpoEmail].filter(Boolean).join(' · ');
      privacy.textContent = [
        p.needsConsent ? 'Thông báo BVDLCN đã cập nhật — cần đồng ý lại.' : `Đã đồng ý thông báo phiên bản ${p.consentedVersion || '—'}.`,
        summary.auditRetentionDays != null ? `Nhật ký bảo mật lưu ${summary.auditRetentionDays || 'không giới hạn'} ngày.` : '',
        dpo ? `Liên hệ DPO: ${dpo}` : '',
      ].filter(Boolean).join(' ');
    }
    const doc = document.querySelector('#privacy-doc');
    if (doc && summary.privacyUrl) doc.href = summary.privacyUrl;
  },
};
async function withReauth(method, path, body) {
  let result = await window.Security.api(method, path, body);
  if (result.body.error === 'step_up_required' && await window.Security.unlock(result.body)) {
    result = await window.Security.api(method, path, body);
  }
  return result;
}
const wipeHistory = document.querySelector('#wp-go');
if (wipeHistory) wipeHistory.onclick = async () => {
  if (!confirm('Xoá toàn bộ lịch sử trên máy chủ? Không thể hoàn tác.')) return;
  const result = await withReauth('POST', '/api/account/data/wipe', {});
  const message = document.querySelector('#acct-msg');
  if (message) message.textContent = result.ok ? `Đã xoá ${result.body.deleted} bản ghi.` : window.Security.errText(result.body.error);
};
const dataExport = document.querySelector('#data-export');
if (dataExport) dataExport.onclick = async () => {
  const result = await withReauth('GET', '/api/account/data/export');
  const message = document.querySelector('#acct-msg');
  if (!result.ok) {
    if (message) message.textContent = window.Security.errText(result.body.error);
    return;
  }
  const blob = new Blob([JSON.stringify(result.body, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `plciot-export-${result.body.profile?.username || 'user'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (message) message.textContent = 'Đã tải tệp xuất dữ liệu.';
};
const acctDelete = document.querySelector('#acct-delete');
if (acctDelete) acctDelete.onclick = async () => {
  if (!confirm('Xoá vĩnh viễn tài khoản và dữ liệu gắn với bạn? Không thể hoàn tác.')) return;
  if (!confirm('Xác nhận lần nữa: bạn sẽ bị đăng xuất và không đăng nhập lại được bằng tài khoản này.')) return;
  const result = await withReauth('POST', '/api/account/delete', {});
  const message = document.querySelector('#acct-msg');
  if (!result.ok) {
    if (message) message.textContent = window.Security.errText(result.body.error);
    return;
  }
  try { localStorage.clear(); } catch { /* ignore */ }
  location.href = '/login.html';
};
const rcGen = document.querySelector('#rc-gen');
if (rcGen) rcGen.onclick = async () => {
  if (!confirm('Tạo bộ mã khôi phục mới? Bộ mã cũ sẽ mất hiệu lực.')) return;
  const result = await withReauth('POST', '/api/account/recovery-codes', {});
  const message = document.querySelector('#acct-msg');
  if (!result.ok) { if (message) message.textContent = window.Security.errText(result.body.error); return; }
  const text = (result.body.codes || []).join('\n');
  const out = document.querySelector('#rc-out');
  out.textContent = text; out.hidden = false;
  document.querySelector('#rc-actions').hidden = false;
  document.querySelector('#rc-copy').onclick = () => navigator.clipboard?.writeText(text).then(() => { if (message) message.textContent = 'Đã sao chép.'; });
  document.querySelector('#rc-dl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    a.download = 'plciot-recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href);
  };
};
document.querySelector('#nav')?.addEventListener('click', (event) => {
  if (event.target.closest('button[data-tab="set"]')) document.dispatchEvent(new Event('security-profile-refresh'));
});
