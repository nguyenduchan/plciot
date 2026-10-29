#!/usr/bin/env node
/**
 * Quản lý gói đăng ký tay trên VPS/PC (KHÔNG thanh toán online).
 * Tiền/chuyển khoản xử lý ngoài hệ thống; script chỉ bật/tắt quyền sau khi bạn đã nhận tiền.
 *
 *   node scripts/plan.js list
 *   node scripts/plan.js show <SĐT>
 *   node scripts/plan.js catalog
 *   node scripts/plan.js grant <SĐT> <monitor|pro|factory> [YYYY-MM-DD|never]
 *   node scripts/plan.js revoke-control <SĐT>     # chỉ xem, giữ retention
 *   node scripts/plan.js allow-control <SĐT>      # bật lại remote_control
 *   node scripts/plan.js set-retention <SĐT> <days|unlimited|default>
 *   node scripts/plan.js transfer <SĐT_cũ> <SĐT_mới>
 *   node scripts/plan.js tenant <id> <monitor|pro|factory> [YYYY-MM-DD|never]
 *
 * Xem docs/SUBSCRIPTION-OPS.md
 */
import path from 'path';
import { openDb, findUserByPhone } from '../src/db.js';
import { normalizePhone, formatVnLocal } from '../src/phone.js';
import {
  parseRetention, setRetention, retentionInfo, defaultDays, purgeByPlan,
} from '../src/retention.js';
import { transferDevice } from '../src/deviceTransfer.js';
import {
  listPlans, grantPlan, setRemoteControl, grantTenantPlan, subscriptionInfo, PLAN_CATALOG,
} from '../src/entitlements.js';
import { getTenant } from '../src/tenants.js';
import { audit } from '@plciot/security';

const db = openDb(path.resolve(process.env.DATA_DIR || './data'));
const [cmd, a, b, c] = process.argv.slice(2);
const admin = process.env.ADMIN_NAME || process.env.USERNAME || process.env.USER || 'admin';
const need = (phone) => {
  const u = findUserByPhone(db, normalizePhone(phone));
  if (!u) { console.error('user not found:', phone); process.exit(1); }
  return u;
};
const label = (u) => {
  const i = retentionInfo(u);
  const s = subscriptionInfo(u);
  const ret = i.unlimited ? '∞ ngày' : `${i.retentionDays} ngày`;
  const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : 'never';
  return `gói=${s.plan} active=${s.active} control=${s.remoteControl} hết=${exp} lưu=${ret}`;
};

if (cmd === 'catalog') {
  for (const p of listPlans()) {
    console.log(`${p.id}\tcontrol=${p.remoteControl}\tretention=${p.unlimited ? '∞' : p.retentionDays}\t${p.label}`);
  }
} else if (cmd === 'list') {
  db.prepare('SELECT * FROM users ORDER BY id').all()
    .forEach((u) => console.log(`${formatVnLocal(u.username)}  ${u.notify_site}/${u.notify_device}  ${label(u)}`));
} else if (cmd === 'show') {
  const u = need(a);
  console.log(`${formatVnLocal(u.username)}: ${label(u)}; mặc định hệ thống = ${defaultDays()} ngày`);
  console.log(JSON.stringify(subscriptionInfo(u), null, 2));
} else if (cmd === 'grant') {
  const u = need(a);
  const planId = b;
  if (!PLAN_CATALOG[planId]) {
    console.error('plans:', Object.keys(PLAN_CATALOG).join(', '));
    process.exit(1);
  }
  const before = label(u);
  const r = grantPlan(db, u.id, planId, { expiresAt: c || 'never', note: `by ${admin}` });
  if (r.error) { console.error(r.error); process.exit(1); }
  audit(db, 'subscription_grant', {
    userId: u.id, detail: `${before} → ${planId} exp=${c || 'never'} by ${admin}`,
  });
  console.log(`${formatVnLocal(u.username)}: ${before}`);
  console.log(`  → ${label(need(a))}`);
  const n = purgeByPlan(db);
  if (n) console.log(`purged ${n} expired rows`);
} else if (cmd === 'revoke-control') {
  const u = need(a);
  setRemoteControl(db, u.id, false);
  audit(db, 'subscription_revoke_control', { userId: u.id, detail: `by ${admin}` });
  console.log(`${formatVnLocal(u.username)}: remote_control=OFF (chỉ giám sát)`);
} else if (cmd === 'allow-control') {
  const u = need(a);
  setRemoteControl(db, u.id, true);
  audit(db, 'subscription_allow_control', { userId: u.id, detail: `by ${admin}` });
  console.log(`${formatVnLocal(u.username)}: remote_control=ON`);
} else if (cmd === 'set-retention' || cmd === 'set') {
  const u = need(a);
  const p = parseRetention(b);
  if (p.error) { console.error(p.error); process.exit(1); }
  const before = label(u);
  setRetention(db, u.id, p.value);
  audit(db, 'retention_set', { userId: u.id, detail: `${before} → retention ${b} by ${admin}` });
  console.log(`${formatVnLocal(u.username)}: ${before} → ${label(need(a))}`);
  const n = purgeByPlan(db);
  if (n) console.log(`purged ${n} expired rows`);
} else if (cmd === 'transfer') {
  const r = await transferDevice(db, need(a).id, need(b).id, { admin });
  console.log(r);
} else if (cmd === 'tenant') {
  const t = getTenant(db, a);
  if (!t) { console.error('tenant not found'); process.exit(1); }
  const r = grantTenantPlan(db, a, b, { expiresAt: c || 'never' });
  if (r.error) { console.error(r.error); process.exit(1); }
  audit(db, 'tenant_subscription_grant', { userId: null, detail: `${a} → ${b} exp=${c || 'never'} by ${admin}` });
  console.log(`tenant ${a}: plan=${b} expires=${c || 'never'}`);
} else {
  console.error(`commands:
  catalog | list | show <SĐT>
  grant <SĐT> <monitor|pro|factory> [YYYY-MM-DD|never]
  revoke-control <SĐT> | allow-control <SĐT>
  set-retention <SĐT> <days|unlimited|default>
  transfer <SĐT_cũ> <SĐT_mới>
  tenant <id> <monitor|pro|factory> [date|never]`);
  process.exit(1);
}
