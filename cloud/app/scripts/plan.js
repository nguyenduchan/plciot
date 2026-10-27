#!/usr/bin/env node
/**
 * Admin: data-retention plan per account and device ownership transfer.
 *
 *   node scripts/plan.js show <SĐT>
 *   node scripts/plan.js set <SĐT> <days>=4 | unlimited | default
 *   node scripts/plan.js list
 *   node scripts/plan.js transfer <SĐT_cũ> <SĐT_mới>   # wipes history, hands site/device to new owner
 *
 * Default retention is HISTORY_DEFAULT_DAYS (3). Paid plans are any integer >= 4, or unlimited.
 * Lowering a plan deletes data older than the new window at the next hourly purge.
 */
import path from 'path';
import { openDb, findUserByPhone } from '../src/db.js';
import { normalizePhone, formatVnLocal } from '../src/phone.js';
import {
  parseRetention, setRetention, retentionInfo, defaultDays, purgeByPlan,
} from '../src/retention.js';
import { transferDevice } from '../src/deviceTransfer.js';
import { audit } from '@plciot/security';

const db = openDb(path.resolve(process.env.DATA_DIR || './data'));
const [cmd, a, b] = process.argv.slice(2);
const admin = process.env.ADMIN_NAME || process.env.USERNAME || process.env.USER || 'admin';
const need = (phone) => {
  const u = findUserByPhone(db, normalizePhone(phone));
  if (!u) { console.error('user not found:', phone); process.exit(1); }
  return u;
};
const label = (u) => {
  const i = retentionInfo(u);
  return i.unlimited ? 'không giới hạn' : `${i.retentionDays} ngày${i.plan === 'default' ? ' (mặc định)' : ''}`;
};

if (cmd === 'list') {
  db.prepare('SELECT * FROM users ORDER BY id').all()
    .forEach((u) => console.log(`${formatVnLocal(u.username)}  ${u.notify_site}/${u.notify_device}  ${label(u)}`));
} else if (cmd === 'show') {
  const u = need(a);
  console.log(`${formatVnLocal(u.username)}: lưu ${label(u)}; mặc định hệ thống = ${defaultDays()} ngày`);
} else if (cmd === 'set') {
  const u = need(a);
  const p = parseRetention(b);
  if (p.error) { console.error(p.error); process.exit(1); }
  const before = label(u);
  setRetention(db, u.id, p.value);
  audit(db, 'retention_set', { userId: u.id, detail: `${before} → ${p.value === null ? 'default' : p.value === 0 ? 'unlimited' : p.value} by ${admin}` });
  const after = need(a);
  console.log(`${formatVnLocal(u.username)}: ${before} → ${label(after)}`);
  const n = purgeByPlan(db);
  if (n) console.log(`purged ${n} expired rows`);
} else if (cmd === 'transfer') {
  const r = await transferDevice(db, need(a).id, need(b).id, { admin });
  console.log(r);
} else {
  console.error('commands: list | show | set | transfer');
  process.exit(1);
}
