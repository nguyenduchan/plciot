// Node-RED function node: kiểm tra PlcSim qua Modbus TCP (jsmodbus). Cấu hình bằng biến môi trường PLC_HOST, PLC_MODBUS_PORT.
const net = global.get('net'), Modbus = global.get('jsmodbus');
const host = env.get('PLC_HOST') || '127.0.0.1', port = Number(env.get('PLC_MODBUS_PORT') || 1502);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sock = new net.Socket();
const client = new Modbus.client.TCP(sock, 1, 3000);
try {
    await new Promise((res, rej) => { sock.once('error', rej); sock.connect({ host, port }, res); });
    const rd = async (a, n) => Buffer.from((await client.readHoldingRegisters(a, n)).response.body.valuesAsArray.flatMap(v => [v >> 8, v & 255]));
    const u16 = async a => (await rd(a, 1)).readUInt16BE(0);
    const wr = async (a, v) => { try { await client.writeSingleRegister(a, v); return 'ok'; } catch (e) { return 'exception'; } };

    // 1. kiểu 16-bit: UINT, INT (có dấu), hệ số 1
    let b = await rd(10, 5);
    check('UINT D10 = 123', b.readUInt16BE(0) === 123, b.readUInt16BE(0));
    check('INT D11 = -5', b.readInt16BE(2) === -5, b.readInt16BE(2));
    check('Chỉ đọc D12 = 77', b.readUInt16BE(4) === 77, b.readUInt16BE(4));
    check('Chỉ ghi D13 khởi tạo 0', b.readUInt16BE(6) === 0, b.readUInt16BE(6));

    // 2. struct: REAL (2 word), DINT (2 word), BOOL (1 word) nằm liền nhau từ D20
    b = await rd(20, 5);
    check('Struct S1.temp REAL D20-21 = 12.5', b.readFloatBE(0) === 12.5, b.readFloatBE(0));
    check('Struct S1.count DINT D22-23 = -70000', b.readInt32BE(4) === -70000, b.readInt32BE(4));
    check('Struct S1.on BOOL D24 = 1', b.readUInt16BE(8) === 1, b.readUInt16BE(8));
    b = await rd(26, 2);
    check('Kiểu REAL đảo word (CD AB) D26-27 = 3.25', Buffer.from([b[2], b[3], b[0], b[1]]).readFloatBE(0) === 3.25, Buffer.from([b[2], b[3], b[0], b[1]]).readFloatBE(0));

    // 3. quyền truy cập
    await wr(10, 456);
    check('Đọc/ghi: ghi D10=456 được chấp nhận', (await u16(10)) === 456, await u16(10));
    await wr(12, 1);
    check('Chỉ đọc: ghi D12 bị từ chối (vẫn 77)', (await u16(12)) === 77, await u16(12));
    await wr(13, 9);
    check('Chỉ ghi: ghi D13=9 được giữ lại', (await u16(13)) === 9, await u16(13));
    await client.writeMultipleRegisters(22, Buffer.from([0xFF, 0xFF, 0xFF, 0xFE]));   // DINT = -2
    b = await rd(22, 2);
    check('Gateway ghi DINT 2 word = -2', b.readInt32BE(0) === -2, b.readInt32BE(0));

    // 4. giả lập giá trị: ngẫu nhiên 10..20 (D14) và sóng sin 0..100 (D30) phải đổi theo thời gian
    const rnd = [], sin = [];
    for (let i = 0; i < 5; i++) { rnd.push(await u16(14)); sin.push(await u16(30)); await sleep(1500); }
    check('Ngẫu nhiên nằm trong 10..20', rnd.every(v => v >= 10 && v <= 20), rnd.join(','));
    check('Ngẫu nhiên thay đổi theo thời gian', new Set(rnd).size > 1, rnd.join(','));
    check('Sóng sin nằm trong 0..100', sin.every(v => v >= 0 && v <= 100), sin.join(','));
    check('Sóng sin thay đổi theo thời gian', new Set(sin).size > 1, sin.join(','));
} catch (e) {
    check('Kết nối/giao tiếp Modbus', false, e.message || e);
} finally { sock.destroy(); }
msg.payload = { suite: 'modbus-tcp', host, port, passed: results.filter(r => r.ok).length, total: results.length, results };
return msg;
