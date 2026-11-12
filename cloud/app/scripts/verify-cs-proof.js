// Xác minh chéo: chữ ký + ID máy do C# (GatewayIdentity) tạo phải được server (gatewayKey.js) chấp nhận.
//   GW_FIXTURE_OUT=<file> dotnet test scada/tests/Plciot.Scada.Tests --filter Xuat_fixture
//   node scripts/verify-cs-proof.js <file>
import fs from 'node:fs';
import { parsePubkey, verifyProof, pairMessage, requestMessage } from '../src/gatewayKey.js';
import { normalizeCode } from '../src/gatewayPairing.js';

const f = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let failed = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failed++; };
const pk = parsePubkey(f.pubkey);
ok(Boolean(pk), 'server nhận khoá công khai SPKI P-256 do C# xuất');
ok(pk?.hw === f.hw, `ID máy C# = server (${f.hw})`);
ok(verifyProof(f.pubkey, pairMessage(normalizeCode(f.pair.code), f.pair.ts), f.pair.sig, f.pair.ts), 'server xác minh chữ ký ghép cặp của C#');
ok(verifyProof(f.pubkey, requestMessage('enroll', f.enroll.site, f.enroll.device, f.enroll.ts), f.enroll.sig, f.enroll.ts), 'server xác minh chữ ký enroll của C#');
ok(!verifyProof(f.pubkey, requestMessage('enroll', f.enroll.site, f.enroll.device, f.enroll.ts), f.enroll.sig, f.enroll.ts), 'chữ ký dùng lại lần hai bị từ chối (replay)');
ok(!verifyProof(f.pubkey, requestMessage('config', f.enroll.site, f.enroll.device, f.enroll.ts), f.enroll.sig, f.enroll.ts), 'chữ ký enroll không dùng được cho config');
console.log(failed ? `\n${failed} FAILED` : '\nverify-cs-proof: all ok');
process.exit(failed ? 1 : 0);
