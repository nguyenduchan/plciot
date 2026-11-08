// Node-RED function node: kiểm tra PlcSim qua OPC UA (node-opcua) + đối chiếu chéo với Modbus. PLC_HOST, PLC_OPCUA_PORT, PLC_MODBUS_PORT.
const O = global.get('opcua'), net = global.get('net'), Modbus = global.get('jsmodbus');
const host = env.get('PLC_HOST') || '127.0.0.1', port = Number(env.get('PLC_OPCUA_PORT') || 4841), mport = Number(env.get('PLC_MODBUS_PORT') || 1502);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });

const client = O.OPCUAClient.create({
    applicationName: 'nodered-plcsim-test', endpointMustExist: false,
    securityMode: O.MessageSecurityMode.None, securityPolicy: O.SecurityPolicy.None,
    connectionStrategy: { initialDelay: 200, maxRetry: 3, maxDelay: 1000 },
});
const sock = new net.Socket(); const mb = new Modbus.client.TCP(sock, 1, 3000);
let session;
try {
    await new Promise((res, rej) => { sock.once('error', rej); sock.connect({ host, port: mport }, res); });
    const mu16 = async a => (await mb.readHoldingRegisters(a, 1)).response.body.valuesAsArray[0];
    await client.connect(`opc.tcp://${host}:${port}/plcsim`);
    session = await client.createSession();
    const ns = (await session.readNamespaceArray()).indexOf('urn:plciot:plcsim');
    check('Namespace urn:plciot:plcsim có trong server', ns > 0, 'ns=' + ns);
    const rd = async id => (await session.read({ nodeId: `ns=${ns};s=${id}`, attributeId: O.AttributeIds.Value })).value.value;
    const wr = (id, dt, v) => session.write({ nodeId: `ns=${ns};s=${id}`, attributeId: O.AttributeIds.Value, value: { value: { dataType: dt, value: v } } });

    // 1. đọc
    const img = await rd('PLC_D');
    check('PLC_D là mảng 300 thanh ghi', img.length === 300, img.length);
    check('PLC_D[40] = 321 (luồng OPC UA o1.val)', img[40] === 321, img[40]);
    check('PLC_W40 = 321', (await rd('PLC_W40')) === 321, await rd('PLC_W40'));
    check('Field d.o1.val (Double) = 321', (await rd('d.o1.val')) === 321, await rd('d.o1.val'));
    check('Struct S1.temp qua OPC UA d.dev2.temp = 12.5 (REAL đã giải mã)', (await rd('d.dev2.temp')) === 12.5, await rd('d.dev2.temp'));
    check('Struct S1.count qua OPC UA d.dev2.count = -2 (DINT, do bài Modbus ghi)', (await rd('d.dev2.count')) === -2, await rd('d.dev2.count'));

    // 2. ghi qua OPC UA → Modbus thấy cùng giá trị (một ảnh D dùng chung)
    let sc = await wr('PLC_W41', O.DataType.UInt16, 999);
    check('Ghi PLC_W41=999 trả Good', sc.isGood(), sc.toString());
    check('Modbus đọc D41 = 999 (đồng bộ chéo giao thức)', (await mu16(41)) === 999, await mu16(41));
    sc = await wr('d.o1.val', O.DataType.Double, 555);
    check('Ghi d.o1.val=555 trả Good', sc.isGood(), sc.toString());
    check('Modbus đọc D40 = 555 (field → thanh ghi D)', (await mu16(40)) === 555, await mu16(40));

    // 3. ngược lại: ghi Modbus → OPC UA thấy
    await mb.writeSingleRegister(40, 777);
    check('Ghi Modbus D40=777 → OPC UA d.o1.val = 777', (await rd('d.o1.val')) === 777, await rd('d.o1.val'));

    // 4. luồng chỉ đọc: gateway ghi vào bị bỏ qua dù OPC UA báo Good
    await wr('PLC_W12', O.DataType.UInt16, 5);
    check('Chỉ đọc D12: ghi qua OPC UA không đổi giá trị (vẫn 77)', (await rd('PLC_W12')) === 77, await rd('PLC_W12'));
} catch (e) {
    check('Kết nối/giao tiếp OPC UA', false, e.message || e);
} finally {
    try { if (session) await session.close(); await client.disconnect(); } catch (e) { /* bỏ qua */ }
    sock.destroy();
}
msg.payload = { suite: 'opc-ua', host, port, passed: results.filter(r => r.ok).length, total: results.length, results };
return msg;
