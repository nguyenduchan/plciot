#!/usr/bin/env node
/**
 * E2E đổi chủ board Waveshare (bán / chuyển board) trên gw-sim — không cần PC cũ:
 *   PC lạ ghép bằng BOOT vào board đang có chủ → board đòi xoá (wipe_required) → đồng ý (Wipe) → board xoá cấu hình, chương trình logic,
 *   nhật ký, PC quản trị cũ (giữ mạng + khoá danh tính), tự khởi động lại → người mới vào thẳng, PC cũ hết quyền.
 *   SIM_DATA=<thư mục trống> SIM_API_PORT=18443 SIM_MBS_PORT=18502 SIM_HTTP_PORT=18080 gateway-mcu/build-sim/gw-sim.exe
 *   node scripts/sim-owner-wipe-e2e.js 127.0.0.1:18443        (gw-sim vừa khởi động: còn cửa sổ ghép của board mới)
 */
import crypto from 'crypto';
import https from 'https';
const [, , target] = process.argv;
const agent = new https.Agent({ rejectUnauthorized: false });
const req = (method, path, body, token) => new Promise((res, rej) => {
  const b = body ? Buffer.from(JSON.stringify(body)) : null;
  const r = https.request(`https://${target}${path}`, { method, agent, headers: { 'content-type': 'application/json', ...(b ? { 'content-length': b.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (s) => {
    let d = ''; s.on('data', (c) => (d += c)); s.on('end', () => { try { res({ st: s.statusCode, j: JSON.parse(d) }); } catch { res({ st: s.statusCode, j: d }); } });
  });
  r.on('error', rej); if (b) r.write(b); r.end();
});
const pc = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
async function login(k, name, wipe) {
  const ch = (await req('GET', '/api/challenge')).j;
  const pk = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`admin-login|${ch.Hw}|${ch.Nonce}`), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return req('POST', '/api/login', { Pubkey: pk, Nonce: ch.Nonce, Sig: sig, Name: name, Wipe: wipe });
}
let bad = 0; const ok = (c, m, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m} ${x}`); if (!c) bad++; };
const pc1 = pc(), pc2 = pc();
const l1 = await login(pc1, 'PC-chu-cu', false);
ok(l1.j.Ok, 'PC chủ cũ ghép (board mới)', JSON.stringify(l1.j).slice(0, 80));
const cfg = (await req('GET', '/api/config', null, l1.j.Token)).j;
cfg.Config.Site = 'site-chu-cu'; cfg.Config.Device = 'gw-bi-mat';
const put = await req('PUT', '/api/config', cfg, l1.j.Token);
ok(put.st === 200, 'chủ cũ lưu cấu hình riêng', put.st);
const l2 = await login(pc2, 'PC-nguoi-mua', false);
ok(l2.st === 409 && l2.j.Err === 'wipe_required', 'PC lạ khi board có chủ: đòi xoá trước', JSON.stringify(l2.j));
const l3 = await login(pc2, 'PC-nguoi-mua', true);
ok(l3.j.Ok && l3.j.Wiped === true, 'đồng ý xoá: ghép được, board báo đã xoá', JSON.stringify(l3.j).slice(0, 80));
await new Promise((r) => setTimeout(r, 6000));   // board khởi động lại
let l4; for (let i = 0; i < 20; i++) { try { l4 = await login(pc2, 'PC-nguoi-mua', false); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
ok(l4?.j.Ok, 'sau khởi động lại: người mua vào thẳng', JSON.stringify(l4?.j).slice(0, 60));
const c2 = (await req('GET', '/api/config', null, l4.j.Token)).j;
ok(c2.Config.Site !== 'site-chu-cu' && c2.Config.Device !== 'gw-bi-mat', 'cấu hình chủ cũ đã mất', `${c2.Config.Site}/${c2.Config.Device}`);
const ad = (await req('GET', '/api/admins', null, l4.j.Token)).j;
ok(Array.isArray(ad) && ad.length === 1 && ad[0].Self, 'chỉ còn PC người mua', JSON.stringify(ad.map((a) => a.Name)));
const ev = JSON.stringify((await req('GET', '/api/events', null, l4.j.Token)).j);
ok(!ev.includes('PC-chu-cu'), 'nhật ký không còn dấu vết chủ cũ', ev.slice(0, 120));
const l5 = await login(pc1, 'PC-chu-cu', false);
ok(!l5.j.Ok, 'PC chủ cũ không còn vào được', JSON.stringify(l5.j));
console.log(bad ? `FAILED ${bad}` : 'TẤT CẢ OK');
process.exit(bad ? 1 : 0);
