#!/usr/bin/env node
/**
 * Gói đăng ký theo username (không SĐT).
 *   node scripts/plan.js grant <username> <monitor|pro|factory> [date|never]
 */
import path from 'path';
import { openDb, findUserByUsername } from '../src/db.js';
import { grantPlan, listPlans } from '../src/entitlements.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const [cmd, username, plan, until] = process.argv.slice(2);
if (cmd !== 'grant' || !username || !plan) {
  console.error('Usage: node scripts/plan.js grant <username> <monitor|pro|factory> [YYYY-MM-DD|never]');
  process.exit(1);
}
const db = openDb(DATA_DIR);
const u = findUserByUsername(db, username);
if (!u) { console.error('user not found'); process.exit(1); }
const expiresAt = until === 'never' || !until ? null : Date.parse(until);
const r = grantPlan(db, u.id, plan, { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
console.log(r.ok ? { ok: true, user: u.username, plan, plans: listPlans() } : r);
