#pragma once
// Khoá CÔNG KHAI ký firmware (ECDSA P-256, SPKI base64url). Board chỉ cài firmware có chữ ký khớp khoá này: `fw1|<sha256>|<phiên bản>`.
// Khoá riêng nằm NGOÀI repo (%USERPROFILE%\.plciot\fw-sign.pem) — ký bằng cloud/app/scripts/sign-mcu-firmware.js.
// Đổi khoá = mọi board đang chạy bản cũ KHÔNG nhận bản ký bằng khoá mới (phải nạp USB) — chỉ đổi khi khoá cũ bị lộ.
#define FW_SIGN_PUBKEY "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWGNiC3CNpaoPIHa9XSExgyjBoGYOycqAdZV-neVMMw9mR7FZUL6Q4yZXO5dYFsISAgT0AMIOkJ18RctHe5zvpw"
