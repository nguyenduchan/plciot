'use strict';
window.AuthApp = {
  contactLabel: 'Xác minh thiết bị',
  presenceHint: (state, seconds) => `Hãy kích hoạt đầu vào X${state.plcBit} trên PLC trong ${seconds} giây.`,
  onAuthConfig() {},
  onAuthenticated(data) {
    let cfg;
    try { cfg = JSON.parse(localStorage.getItem('cfg')) || {}; } catch { cfg = {}; }
    cfg.demo = false;
    if (data.mqtt) {
      Object.assign(cfg, { user: data.mqtt.user, pass: data.mqtt.pass, site: data.mqtt.site, dev: data.mqtt.device, controlVia: data.mqtt.controlVia || 'mqtt' });
    } else if (data.notifySite) Object.assign(cfg, { site: data.notifySite, dev: data.notifyDevice });
    localStorage.setItem('cfg', JSON.stringify(cfg));
  },
  onDemo() {
    let cfg;
    try { cfg = JSON.parse(localStorage.getItem('cfg')) || {}; } catch { cfg = {}; }
    localStorage.setItem('cfg', JSON.stringify({ ...cfg, demo: true }));
  },
  onSecuritySummary(summary) {
    const retention = document.querySelector('#ret-info');
    if (retention) retention.textContent = summary.unlimited ? 'Lưu dữ liệu không giới hạn thời gian.' : `Lưu dữ liệu ${summary.retentionDays} ngày.`;
    const privacy = document.querySelector('#privacy-info');
    if (privacy) {
      const p = summary.privacy || {};
      const dpo = [summary.dpoContact, summary.dpoEmail].filter(Boolean).join(' · ');
      privacy.textContent = [
        p.needsConsent ? 'Thông báo BVDLCN đã cập nhật — cần đồng ý lại.' : `Đã đồng ý notice ${p.consentedVersion || '—'}.`,
        summary.auditRetentionDays != null ? `Nhật ký bảo mật giữ ${summary.auditRetentionDays || 'không giới hạn'} ngày.` : '',
        dpo ? `DPO: ${dpo}` : '',
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
document.querySelector('#nav')?.addEventListener('click', (event) => {
  if (event.target.closest('button[data-tab="set"]')) document.dispatchEvent(new Event('security-profile-refresh'));
});
