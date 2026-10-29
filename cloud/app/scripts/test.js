import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'scripts/smoke-bundle-cache.js',
  'scripts/smoke-login-ui.js',
  'scripts/smoke-login.js',
  '../../packages/security/test/smoke-device-proof.js',
  '../../packages/security/test/smoke-auth-flows.js',
  '../../packages/security/test/smoke-session.js',
  '../../packages/security/test/smoke-recovery-ui.js',
  '../../packages/security/test/smoke-security.js',
  'scripts/smoke-server.js',
  'scripts/smoke-control.js',
  'scripts/smoke-sites.js',
  'scripts/smoke-roles.js',
  'scripts/smoke-contract.js',
  'scripts/smoke-partner-api.js',
  'scripts/smoke-entitlements.js',
  'scripts/smoke-device-binding.js',
  'scripts/smoke-policy.js',
  'scripts/smoke-deploy.js',
  'scripts/smoke-account.js',
  'scripts/smoke-retention.js',
];

const reportPath = process.argv.find((argument) => argument.startsWith('--report='))?.slice('--report='.length);
const report = { startedAt: new Date().toISOString(), status: 'running', total: tests.length, passed: [] };
const saveReport = () => { if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
saveReport();
let passed = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, [test], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    report.status = 'failed';
    report.failed = test;
    report.exitCode = result.status;
    saveReport();
    console.error(`FAIL ${test}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    if (result.signal) console.error(`Terminated by ${result.signal}`);
    process.exit(1);
  }
  passed++;
  report.passed.push(test);
  saveReport();
  console.log(`PASS ${test}`);
}
report.status = 'passed';
report.finishedAt = new Date().toISOString();
saveReport();
console.log(`All ${passed}/${tests.length} test groups passed`);