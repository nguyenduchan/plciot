// Minimal Node-RED settings for the edge bridge.
module.exports = {
  flowFile: 'flows.json',
  credentialSecret: false,          // flows_cred.json is plain text: keep it out of git and off shared disks
  uiPort: process.env.PORT || 1880,
  logging: { console: { level: 'info', metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false } },
  functionExternalModules: false,
  functionTimeout: 0,
};
