/**
 * Bảo mật tài khoản (danh tính thiết bị; không SĐT / email / Telegram / OTP ngoài).
 */
import { audit } from './audit.js';
import { notify, getConfig } from './config.js';
import { generateRecoveryCodes, recoveryCodesRemaining } from './recoveryCodes.js';
import { privacyConsentStatus, privacyPublicConfig } from './privacy.js';

export function cancelToken() { return ''; }
export function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function accountSecuritySummary(db, user) {
  return {
    username: user.username,
    hasPassword: Boolean(user.login_password_hash),
    recoveryCodesRemaining: recoveryCodesRemaining(db, user.id),
    coolingHours: 24,
    privacy: privacyConsentStatus(user),
    ...privacyPublicConfig(),
    ...getConfig().accountExtra(user),
    pending: [],
  };
}

export async function regenerateRecoveryCodes(db, user, { reauthed, ip }) {
  if (reauthed !== true) return { error: 'invalid_credentials', status: 401 };
  const codes = generateRecoveryCodes(db, user.id);
  audit(db, 'recovery_codes_regenerated', { userId: user.id, ip });
  notify(db, user, {
    subject: 'Mã khôi phục đã được tạo lại',
    html: '<b>🔑 Bộ mã khôi phục mới đã được tạo</b>; bộ cũ không còn hiệu lực.',
  });
  return { ok: true, codes };
}

export async function processDueChanges() { return { processed: 0 }; }
