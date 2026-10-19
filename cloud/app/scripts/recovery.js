#!/usr/bin/env node
/**
 * Admin console for phone-recovery tickets (runs on the server host = admin authentication).
 *
 *   node scripts/recovery.js list [status]        # default: pending_review
 *   node scripts/recovery.js show <id>
 *   node scripts/recovery.js approve <id> [hours] # starts cooling-off (default RECOVERY_COOLING_HOURS=48)
 *   node scripts/recovery.js reject <id> [reason]
 *   node scripts/recovery.js audit <phone> [n]
 *
 * Before approving, check the evidence in `show`: new number OTP-verified, PLC presence proof,
 * recovery code, free-text note (site/serial), and ask for ID/receipt out of band if needed.
 * The old owner is notified on every step and can veto during the cooling-off.
 */
import path from 'path';
import { openDb, findUserByPhone, findUserById } from '../src/db.js';
import { listChanges, getChangeRow, approveRecovery, rejectChange } from '../src/accountSecurity.js';
import { formatVnLocal, normalizePhone } from '../src/phone.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const db = openDb(DATA_DIR);
const [cmd = 'list', a, b] = process.argv.slice(2);
const admin = process.env.ADMIN_NAME || process.env.USERNAME || process.env.USER || 'admin';
const t = (ms) => (ms ? new Date(ms).toISOString() : '-');

function brief(r) {
  return `${r.id}  ${r.status.padEnd(14)} ${r.kind.padEnd(8)} ${formatVnLocal(r.old_phone)} → ${formatVnLocal(r.new_phone)}  `
    + `newOTP=${r.new_verified ? 'ok' : 'no'} code=${r.recovery_code_ok ? 'ok' : 'no'} plc=${r.plc_ok ? 'ok' : 'no'}  ${t(r.created_at)}`;
}

if (cmd === 'list') {
  const rows = listChanges(db, a || 'pending_review');
  console.log(rows.length ? rows.map(brief).join('\n') : '(none)');
} else if (cmd === 'show') {
  const r = getChangeRow(db, a);
  if (!r) { console.error('not found'); process.exit(1); }
  const u = findUserById(db, r.user_id);
  console.log(JSON.stringify({
    ...r,
    new_otp_hash: undefined,
    old_otp_hash: undefined,
    account: {
      id: u?.id, site: u?.notify_site, device: u?.notify_device,
      hasTelegram: Boolean(u?.chat_id), hasVerifiedEmail: Boolean(u?.email_verified),
    },
    created_at: t(r.created_at),
    execute_at: t(r.execute_at),
  }, null, 2));
} else if (cmd === 'approve') {
  console.log(await approveRecovery(db, a, { hours: b, admin }));
} else if (cmd === 'reject') {
  console.log(await rejectChange(db, a, { reason: b || '', admin }));
} else if (cmd === 'audit') {
  const u = findUserByPhone(db, normalizePhone(a));
  if (!u) { console.error('user not found'); process.exit(1); }
  const rows = db.prepare('SELECT ts, event, ip, detail FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(u.id, Number(b || 50));
  rows.forEach((x) => console.log(`${t(x.ts)}  ${x.event.padEnd(28)} ${x.ip || '-'}  ${x.detail || ''}`));
} else {
  console.error('commands: list | show | approve | reject | audit');
  process.exit(1);
}
