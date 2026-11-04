/**
 * Thông báo / đồng ý xử lý dữ liệu cá nhân (BVDLCN).
 * Phiên bản notice: đổi PRIVACY_NOTICE_VERSION khi cập nhật nội dung quan trọng → bắt buộc đồng ý lại.
 */
export const PRIVACY_NOTICE_VERSION = process.env.PRIVACY_NOTICE_VERSION || '2026-11-01';

export function privacyPublicConfig() {
  return {
    privacyVersion: PRIVACY_NOTICE_VERSION,
    privacyUrl: process.env.PRIVACY_URL || '/privacy.html',
    dpoContact: String(process.env.DPO_CONTACT || process.env.PRIVACY_DPO_CONTACT || '').trim() || null,
    dpoEmail: String(process.env.DPO_EMAIL || process.env.PRIVACY_DPO_EMAIL || '').trim() || null,
    auditRetentionDays: auditRetentionDays(),
  };
}

/** Số ngày giữ audit_log (mặc định 365). 0 = không tự xoá. */
export function auditRetentionDays() {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  if (n === 0) return 0;
  return Number.isInteger(n) && n > 0 ? n : 365;
}

export function purgeExpiredAudit(db, now = Date.now()) {
  const days = auditRetentionDays();
  if (!days) return 0;
  const cutoff = now - days * 86_400_000;
  return db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes;
}

/** Body claim/invite phải có consent=true (và version khớp nếu client gửi). */
export function requirePrivacyConsent(body) {
  if (body?.consent !== true && body?.privacyConsent !== true) {
    return { error: 'privacy_consent_required', status: 400 };
  }
  const v = body?.privacyVersion != null ? String(body.privacyVersion).trim() : '';
  if (v && v !== PRIVACY_NOTICE_VERSION) {
    return { error: 'privacy_version_mismatch', status: 400, privacyVersion: PRIVACY_NOTICE_VERSION };
  }
  return { ok: true, version: PRIVACY_NOTICE_VERSION };
}

export function recordPrivacyConsent(db, userId, { version = PRIVACY_NOTICE_VERSION, ip } = {}) {
  const at = Date.now();
  db.prepare('UPDATE users SET privacy_consent_at = ?, privacy_version = ? WHERE id = ?')
    .run(at, version, userId);
  return { privacyConsentAt: at, privacyVersion: version, ip: ip || null };
}

export function privacyConsentStatus(user) {
  const version = String(user?.privacy_version || '');
  const at = user?.privacy_consent_at ? Number(user.privacy_consent_at) : null;
  const current = PRIVACY_NOTICE_VERSION;
  return {
    privacyVersion: current,
    consentedVersion: version || null,
    privacyConsentAt: Number.isFinite(at) ? at : null,
    needsConsent: !version || version !== current,
  };
}
