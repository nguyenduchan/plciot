'use strict';
window.AuthApp = {
  contactLabel: 'OTP Telegram (số hiện tại)',
  presenceHint: (state, seconds) => `Hãy kích hoạt đầu vào X${state.plcBit} trên PLC trong ${seconds} giây.`,
  onAuthConfig(config) {
    const hint = document.querySelector('#tg-hint');
    if (!hint) return;
    if (config.botLink) {
      const link = document.createElement('a');
      link.href = config.botLink; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `@${config.botUsername || ''}`;
      hint.replaceChildren('Mở ', link, ', bấm /start và chia sẻ số điện thoại để nhận OTP.');
    } else if (!config.telegram) hint.textContent = 'Máy chủ chưa cấu hình Telegram.';
  },
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
  },
};
const wipeHistory = document.querySelector('#wp-go');
if (wipeHistory) wipeHistory.onclick = async () => {
  if (!confirm('Xoá toàn bộ lịch sử trên máy chủ? Không thể hoàn tác.')) return;
  let result = await window.Security.api('POST', '/api/account/data/wipe', {});
  if (result.body.error === 'step_up_required' && await window.Security.unlock(result.body)) result = await window.Security.api('POST', '/api/account/data/wipe', {});
  const message = document.querySelector('#acct-msg');
  if (message) message.textContent = result.ok ? `Đã xoá ${result.body.deleted} bản ghi.` : window.Security.errText(result.body.error);
};
document.querySelector('#nav')?.addEventListener('click', (event) => {
  if (event.target.closest('button[data-tab="set"]')) document.dispatchEvent(new Event('security-profile-refresh'));
});