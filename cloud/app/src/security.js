/** Quy tắc truy cập riêng của app PLC. Header bảo mật và CORS nằm ở @plciot/security. */

/** History only for user's bound site/device unless HISTORY_OPEN_ACCESS=true. */
export function assertHistoryAccess(user, site, device) {
  if (String(process.env.HISTORY_OPEN_ACCESS || '').toLowerCase() === 'true') return true;
  return user.notify_site === site && user.notify_device === device;
}
