/**
 * @plciot/security — lõi bảo mật dùng chung cho mọi app (PLC, SCADA web, app khác của từng khách hàng).
 *
 * Dùng:
 *   import { configure, migrateSecurity, mountSecurityRoutes, securityHeaders, buildCorsOptions } from '@plciot/security';
 *   configure({ secret, publicUrl, notify, email, canControl, brand });   // một lần lúc khởi động
 *   migrateSecurity(db);                                                   // sau khi có bảng users
 *   const sec = mountSecurityRoutes(app, { db, requireAuth, loginPayload, authStrict, adminOnly });
 *   // route lệnh của app: dùng sec.authorize(req) / sec.reauth / enrollState(db, user)
 */
export { configure, getConfig, notify, keyFrom, rawSecret } from './config.js';
export { migrateSecurity } from './schema.js';
export { mountSecurityRoutes } from './routes.js';
export { mountAuthentication } from './flows.js';
export { hashPassword, verifyPassword, signToken, verifyToken, bearerUser, jwtTtlSeconds,
  loginScopeAllowed, createLoginChallenge, consumeLoginChallenge, createAppSession, createSessionAuth, mountLoginSessions } from './auth.js';
export { requestLoginOtp, verifyLoginOtp, requestRegisterOtp, verifyRegisterOtp } from './otp.js';
export { normalizePhone, isValidVnPhone, formatVnLocal, formatVnIntl, phoneVariants } from './phone.js';
export { canonicalDeviceKey, deviceFingerprint, verifyDeviceProof, rememberAuthDevice, recoveryEnrollmentAllowed } from './deviceProof.js';
export { canBindVerifiedContact, createOtpChallenge, getOtpChallenge, bumpOtpFail, deleteOtpChallenge } from './accounts.js';
export { accountSecuritySummary, emailChannelAvailable, requestEmailVerify, verifyEmail, regenerateRecoveryCodes,
  startSelfChange, confirmSelfChange, startRecovery, confirmRecovery, recoveryStatus, cancelChange,
  approveRecovery, rejectChange, processDueChanges, listChanges, getChangeRow, applyChange } from './accountSecurity.js';
export { cancelToken, htmlToText, emailQuarantineMs, startPlcChallenge, checkPlcChallenge,
  startPlcChallenge as startPresenceProof, checkPlcChallenge as checkPresenceProof } from './accountSecurity.js';
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
export { noteLogin, isFirstDevice } from './loginAlerts.js';
export {
  startDeviceRequest, listDeviceRequests, pendingDeviceCount, decideDeviceRequest, deviceViaRecoveryCode, deviceViaWait,
  deviceEmailStart, deviceEmailConfirm, pollDeviceRequest, peekTicket, consumeTicket, cancelDeviceByLink, deviceCancelToken,
  emailAvailable, sweepRequests,
} from './deviceApproval.js';
export {
  createPairCode, pairStation, revokeStation, stationAuth, stationMessage,
} from './stationAuth.js';
