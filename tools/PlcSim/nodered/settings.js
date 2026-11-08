// Node-RED chạy test PlcSim: chỉ cần cho function node dùng jsmodbus / node-opcua / net có sẵn trong image.
const nm = '/usr/src/node-red/node_modules/';
module.exports = {
    uiPort: 1880,
    flowFile: 'flows.json',
    credentialSecret: false,
    functionTimeout: 0,
    functionGlobalContext: { net: require('net'), jsmodbus: require(nm + 'jsmodbus'), opcua: require(nm + 'node-opcua') },
    logging: { console: { level: 'info', metrics: false, audit: false } },
};
