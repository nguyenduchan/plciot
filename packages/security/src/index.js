/**
 * @plciot/security — lõi bảo mật (danh tính theo thiết bị QR; không SĐT/Telegram/email/OTP).
 */
export { configure, getConfig, notify, keyFrom, rawSecret } from './config.js';
export { migrateSecurity } from './schema.js';
export { mountSecurityRoutes } from './routes.js';
export { mountAuthentication } from './flows.js';
export { hashPassword, verifyPassword, signToken, verifyToken, bearerUser, jwtTtlSeconds,
  loginScopeAllowed, createLoginChallenge, consumeLoginChallenge, createAppSession, createSessionAuth, mountLoginSessions } from './auth.js';
export { canonicalDeviceKey, deviceFingerprint, verifyDeviceProof, rememberAuthDevice, recoveryEnrollmentAllowed } from './deviceProof.js';
export { findUserById, findUserByUsername } from './accounts.js';
export {
  accountSecuritySummary, regenerateRecoveryCodes, processDueChanges, cancelToken, htmlToText,
} from './accountSecurity.js';
export { securityHeaders, buildCorsOptions } from './headers.js';
export { rateLimit } from './rateLimit.js';
export { clientIp, netOf, ipInCidrs } from './net.js';
export { audit, countAudit } from './audit.js';
export {
  securityConfig, createControlSession, revokeControlSessions, checkControlSession,
  factorSummary, enrollState, createStation, listStations, deleteStation, stationOk,
} from './sessions.js';
export {
  generateSecret, otpauthUri, verifyTotp, hotp, stepOf, sealSecret, openSecret, base32Encode, base32Decode,
} from './totp.js';
export {
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication,
} from './webauthn.js';
export {
  generateRecoveryCodes, recoveryCodesRemaining, consumeRecoveryCode, tryRecoveryCode, normalizeCode,
} from './recoveryCodes.js';
export { noteLogin, isFirstDevice, isDeviceTrusted, markDeviceTrusted, isOtpTrusted, markOtpTrusted } from './loginAlerts.js';
export {
  startDeviceRequest, listDeviceRequests, pendingDeviceCount, decideDeviceRequest, deviceViaRecoveryCode, deviceViaWait,
  pollDeviceRequest, peekTicket, consumeTicket, cancelDeviceByLink, deviceCancelToken, sweepRequests,
} from './deviceApproval.js';
export {
  createPairCode, pairStation, revokeStation, stationAuth, stationMessage,
} from './stationAuth.js';
export {
  generateClaimRootKeyPair, provisionHardwareDevice, claimHardwareDevice, acceptInviteToken,
  encodeClaimQr, decodeClaimQr, signClaimPayload, verifyClaimSignature, identitySubject,
  listHardwareDevices, getHardwareDeviceQr, reissueHardwareDeviceQr,
  updateHardwareDeviceMeta, deleteHardwareDevice, hashClaimSecret,
  issueActivationCode, verifyActivationCode, verifyLicenseKey, bindGatewayHardware, releaseGatewayHardware, parseHardwareId, parseActivationRequest, deriveDeviceKey,
} from './deviceClaim.js';
export {
  PRIVACY_NOTICE_VERSION, privacyPublicConfig, requirePrivacyConsent, recordPrivacyConsent,
  privacyConsentStatus, auditRetentionDays, purgeExpiredAudit,
} from './privacy.js';
