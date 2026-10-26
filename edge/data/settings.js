// Node-RED settings for the edge bridge.
const path = require('path');
module.exports = {
  flowFile: 'flows.json',
  credentialSecret: false,          // flows_cred.json is plain text: keep it out of git and off shared disks
  uiPort: process.env.PORT || 1880,
  logging: { console: { level: 'info', metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false } },
  functionExternalModules: false,
  functionTimeout: 0,
  // Trang /scada (giám sát + điều khiển cục bộ) có đăng nhập nhiều tài khoản + vai trò. Xem scada-auth.js
  httpNodeMiddleware: require(path.join(__dirname, 'scada-auth.js')),
  // Trình soạn thảo chỉ nghe loopback ở phía host (docker-compose); đặt adminAuth nếu mở ra ngoài.
};
