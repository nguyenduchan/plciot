# Chuyển dữ liệu từ SQLite sang PostgreSQL (không mất dữ liệu)

Hiện dùng SQLite (`data/app.db`, WAL). Khi cần PostgreSQL (nhiều máy, nhiều bản app, dung lượng lớn), dùng `cloud/app/scripts/db-export.js`.
Công cụ **chỉ đọc** SQLite (bản chụp nhất quán qua API backup), nên chạy được khi app đang chạy.

## Quy trình
1. **Xuất** (có thể làm trước nhiều ngày để thử):
   ```bash
   node scripts/db-export.js export --db data/app.db --out ./export
   ```
   Ra `./export/<bảng>.csv` + `manifest.json` (số dòng, sha256, cột, lược đồ SQLite).
2. **Sinh lược đồ PostgreSQL**:
   ```bash
   node scripts/db-export.js pg-schema --export ./export
   ```
   Ra `schema.pg.sql` và `import.psql`. Mở `schema.pg.sql`, xử lý các dòng `-- XEM LẠI` (mặc định dùng hàm SQLite như `datetime('now')`, chỉ mục dùng `COLLATE NOCASE`…).
3. **Nạp vào PostgreSQL**: `psql -f schema.pg.sql`, rồi từ thư mục chứa CSV `psql -f import.psql`. Script nạp trong một transaction, đặt lại sequence của khoá tự tăng và in bảng đối chiếu số dòng với manifest (`khop = t`).
4. **Chốt (cutover) không mất dữ liệu**:
   - Dừng ghi (dừng app hoặc `ops flag` mqtt_ingest_open; hàng đợi broker giữ message, xem docs/SHARDING.md).
   - Xuất lại bản cuối, `verify` với DB nguồn phải KHỚP, nạp vào PostgreSQL, đối chiếu số dòng.
   - Đổi app sang lớp truy cập PostgreSQL, bật lại ghi. Giữ nguyên file SQLite làm đường lui vài ngày.

## Đối chiếu bất cứ lúc nào
```bash
node scripts/db-export.js verify --db data/app.db --export ./export
```
Xuất lại và so từng bảng (số dòng + sha256) với manifest, và kiểm file CSV chưa bị sửa. Chạy trên DB đang ghi sẽ báo khác vì dữ liệu đã thêm — chỉ có ý nghĩa khi so với một bản chụp tĩnh hoặc lúc đã dừng ghi.

## Điểm cần biết
- **Phần code**: lịch sử telemetry gói gọn trong `historyStore.js` (8 hàm) — nơi duy nhất đổi khi chuyển lịch sử. Phần tài khoản/thiết bị còn nằm rải rác ~600 chỗ gọi `better-sqlite3` đồng bộ nên khi chuyển phải đổi sang bất đồng bộ (việc lớn, làm một lần). Dữ liệu không phụ thuộc điều này: xuất/nạp độc lập với code.
- **Giá trị biên đã kiểm** (test `smoke-db-export.js`): NULL khác chuỗi rỗng khác chuỗi `\N`, dấu nháy, dấu phẩy, xuống dòng, Unicode, BLOB (`\x…`), khoá chính ghép, bảng không khoá chính.
- **Chưa kiểm** nạp thật vào một PostgreSQL (môi trường này không chạy Postgres): thử trên một PostgreSQL tạm trước khi chốt.
