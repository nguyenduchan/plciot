# Node-RED với đủ node giao thức công nghiệp + InfluxDB. Chạy tại nhà máy, cạnh PLC.
#   Modbus TCP · Siemens S7 · OPC UA · Rockwell EtherNet/IP · Mitsubishi MC · Omron FINS · Beckhoff ADS
FROM nodered/node-red:4.1
RUN npm install --no-audit --no-fund --omit=dev \
    node-red-contrib-modbus@5.62.1 \
    node-red-contrib-s7@3.1.3 \
    node-red-contrib-opcua@0.2.355 \
    node-red-contrib-cip-ethernet-ip@1.1.3 \
    node-red-contrib-mcprotocol \
    node-red-contrib-omron-fins@0.5.0 \
    node-red-contrib-ads-client@2.0.1 \
    node-red-contrib-influxdb@0.7.0
