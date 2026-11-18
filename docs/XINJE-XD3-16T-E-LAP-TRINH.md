# PLC Xinje XD3-16T-E — Tập lệnh và hướng dẫn lập trình (tiếng Việt)

> Nguồn: *XD/XL series PLC User Manual [Instruction]*, WUXI XINJE, Data No. PD05 20201022 v3.5
> ([bản PDF](https://download.plcsystems.ru/Xinje/docs/XDXL_instruction_manual.pdf)).
> Tài liệu này là bản **tóm lược + diễn giải tiếng Việt**, không phải bản dịch nguyên văn.
> Phần phần cứng (đấu dây, thông số điện) xem *XD/XL hardware manual* của Xinje. Dùng phần mềm lập trình **XDPPro** — cách thêm lệnh bằng icon/menu/phím tắt xem **mục 6**.

## 0. Giới thiệu nhanh về XD3-16T-E

| Mục | Nội dung |
|---|---|
| Dòng | XD3 (thuộc nhóm XD/XL, dùng chung tập lệnh) |
| Số I/O | **16 I/O**: ngõ vào `X0~X7` (8 điểm), ngõ ra `Y0~Y7` (8 điểm) |
| Kiểu ngõ ra | `T` = transistor (tốc độ cao, dùng được xuất xung `Y0`, `Y1`) |
| Hậu tố `E` | Biến thể của model; **chưa xác nhận từ tài liệu lệnh** — kiểm tra nhãn máy / hardware manual |
| Địa chỉ I/O | **Hệ bát phân** (X0..X7, rồi X10..) — thực tế 16 I/O chỉ dùng X0–X7, Y0–Y7 |
| Mở rộng | Tối đa **10 mô-đun mở rộng** (X/Y10000…). **Không gắn được bo BD** (PLC 16 điểm). ED mở rộng trái: chưa xác nhận riêng cho 16T |

## 1. Phần tử mềm (soft component) của XD3

| Ký hiệu | Ý nghĩa | Dải XD3 | Khả dụng trên XD3-16T-E | Ghi chú |
|---|---|---|---|---|
| `X` | Ngõ vào | X0~X7 (16 I/O) | ✅ **X0~X7** (8 điểm) | Bát phân. X10 trở lên chỉ có khi gắn mô-đun mở rộng. Ngõ X nhận xung HSC/ngắt thì không dùng làm đầu vào thường cùng lúc |
| `Y` | Ngõ ra | Y0~Y7 (16 I/O) | ✅ **Y0~Y7** (8 điểm, transistor) | Bát phân. **Chỉ Y0, Y1 xuất xung/PWM**. Địa chỉ Y vượt số điểm vật lý (Y10…) dùng được như rơ-le trung gian |
| `M` | Rơ-le trung gian (mất khi tắt nguồn) | M0~M69999 | ✅ Đầy đủ | |
| `HM` | Rơ-le trung gian **giữ khi mất điện** | HM0~HM11999 | ✅ Đầy đủ | Vùng giữ điện cố định, không đổi được |
| `SM` | Rơ-le đặc biệt | SM0~SM4999 | ✅ Đầy đủ | Không dùng như M thường |
| `S` / `HS` | Bước/luồng (flow) / giữ điện | S0~S1023 / HS0~HS127 | ✅ Đầy đủ | Dùng với STL |
| `T` | Timer thường | T0~T575 | ✅ Đầy đủ | |
| `HT` | Timer tích lũy, giữ khi mất điện | HT0~HT95 | ✅ Đầy đủ | |
| `ET` | Timer chính xác | ET0~ET31 | ⚠️ Có, **xung đột tài nguyên** | Trùng kênh với HSC và xuất xung Y0/Y1 (mục 4.9) |
| `C` | Counter thường | C0~C575 | ✅ Đầy đủ | |
| `HC` | Counter giữ khi mất điện | HC0~HC95 | ✅ Đầy đủ | |
| `HSC` | Counter tốc độ cao | HSC0~HSC30 (số chẵn) | ⚠️ Khai báo tới HSC31 nhưng **16T chỉ có 3 kênh** (HSC0, HSC2, HSC4) | HSC0 80 kHz; HSC2/HSC4 10 kHz (một pha) |
| `D` | Thanh ghi dữ liệu 16-bit | D0~D7999 | ✅ Đầy đủ | |
| `HD` | Thanh ghi giữ khi mất điện | HD0~HD999 | ✅ Đầy đủ | |
| `SD` / `HSD` | Thanh ghi đặc biệt | SD0~SD2047 / HSD0~HSD499 | ✅ Đầy đủ | |
| `FD` / `SFD` / `FS` | Thanh ghi Flash | FD0~FD5119, SFD0~SFD1999, FS0~FS47 | ✅ Đầy đủ | Ghi bằng `FWRT` (~150 ms/lần, ~1.000.000 lần ghi) |
| `P` | Con trỏ (nhãn nhảy / chương trình con) | P0~P9999 | ✅ Đầy đủ | CJ, CALL |
| `I` | Con trỏ ngắt | Ngắt ngoài X2.. (I0000/I0001…), ngắt timer I40**~I59** | ⚠️ Ngắt ngoài chỉ **X2~X7** (6 ngõ); ngắt timer 20 cái | Ngắt sườn lên và xuống |
| `K` / `H` | Hằng thập phân / thập lục | | ✅ | `K100`, `H1122` |
| X/Y **mô-đun mở rộng** | X/Y10000… | XD3 nhận tối đa **10 mô-đun** | ⚠️ Chỉ khi gắn mô-đun | Mô-đun 1 bắt đầu X10000/Y10000, mô-đun 2 từ X10100/Y10100 |
| X/Y **BD** | X20000… | | ❌ **Không hỗ trợ** | Sổ tay: PLC 16 điểm không gắn được bo BD (chỉ 24–32 điểm: 1 BD; 48–60 điểm: 2 BD) |
| X/Y **ED** (mô-đun mở rộng trái) | X30000/Y30000… | 1 mô-đun | ⚠️ Chưa xác nhận riêng cho 16T | Sổ tay nói dòng XD/XL hỗ trợ 1 ED; xem hardware manual cho XD3-16 |

### 1.1 Chi tiết từng loại phần tử mềm

> Nguồn: sổ tay XD/XL mục 2 (soft component), kèm xác nhận riêng cho **XD3-16T-E** ở những chỗ có số liệu.

#### `X` — Ngõ vào (input relay)

**Là gì:** ảnh nội bộ của các **đầu vào vật lý**. Mỗi `X` ứng với một đầu vào cách ly quang (opto) của PLC. Trạng thái ON/OFF phản ánh tín hiệu bên ngoài (nút nhấn, cảm biến, công tắc hành trình).

**Cách hoạt động:**
- Trước khi chạy chương trình, PLC **đọc toàn bộ đầu vào** và chép vào *vùng ảnh ngõ vào*. Trong suốt chu kỳ quét, giá trị trong vùng ảnh **không đổi** dù tín hiệu ngoài có đổi, đến chu kỳ sau mới cập nhật.
- Muốn đọc trực tiếp từ chân, dùng `LDD`, `ANDD`, `ORD`… (mục 3.1).
- `X` chỉ **đọc**, không dùng `OUT` cho `X`.

**Trên XD3-16T-E:** `X0~X7` (8 điểm, **bát phân**). Địa chỉ `X10` trở lên chỉ có khi gắn mô-đun mở rộng (`X10000…`). Địa chỉ `X` không nối thiết bị có thể dùng như rơ-le trung gian tốc độ cao.

**Lưu ý:** các ngõ `X0~X7` còn là ngõ **xung HSC** và **ngắt ngoài** (`X2~X7`); khi dùng cho mục đích đó thì không dùng làm ngõ vào thường cùng lúc.

```ladder
# Y0 = X0 · ¬X1  (X0 nhấn, X1 chưa nhấn)
NO:X0 NC:X1 OUT:Y0
```

#### `Y` — Ngõ ra (output relay)

**Là gì:** ảnh nội bộ của các **đầu ra vật lý** để điều khiển tải bên ngoài (đèn, contactor, van, biến tần…).

**Cách hoạt động:**
- Chương trình ghi vào *vùng ảnh ngõ ra*. **Sau khi chạy hết chương trình**, PLC mới chuyển toàn bộ vùng ảnh ra chân đầu ra thật. Nên một `Y` bị `OUT` hai lần (*dual coil*) chỉ lần cuối có tác dụng.
- Muốn xuất ngay trong chương trình dùng `OUTD`.

**Trên XD3-16T-E:** `Y0~Y7` (8 điểm, **transistor**, bát phân). **Chỉ `Y0`, `Y1` xuất được xung/PWM** (tối đa 100 kHz); `Y2~Y7` chỉ là ngõ ra thường. Địa chỉ `Y` vượt số điểm vật lý (`Y10`…) dùng được như rơ-le trung gian nếu không gắn mô-đun mở rộng.

**Lưu ý:** ngõ ra transistor chỉ chịu dòng nhỏ và có cực tính; tải lớn cần rơ-le/contactor trung gian bên ngoài.

#### `M`, `HM`, `SM` — Rơ-le trung gian và đặc biệt

Đã mô tả ở mục dưới đây. Tóm tắt: `M0~M69999` mất trạng thái khi tắt nguồn; `HM0~HM11999` **giữ trạng thái** khi mất điện (vùng giữ cố định, không đổi được); `SM0~SM4999` là rơ-le **do hệ thống định nghĩa** (`SM0` luôn ON, `SM2` xung khởi động, `SM11` xung dao động, `SM34` cấm ngõ ra, `SM20/21/22` cờ 0/mượn/nhớ). Mỗi rơ-le có vô hạn tiếp điểm NO/NC, nhưng **không điều khiển được tải ngoài**.

#### `S`, `HS` — Trạng thái / luồng (status relay, flow)

**Là gì:** rơ-le dành cho **điều khiển tuần tự** (từng bước). Mỗi `S` đại diện một bước (flow). Dùng cùng lệnh `STL Sn … STLE`.

**Hai loại:** `S0~S1023` (thường, **OFF khi tắt nguồn**); `HS0~HS127` (**giữ ON/OFF** khi mất điện — để tiếp tục đúng bước sau khi cấp điện lại).

**Cách dùng:**
- `SET Sn`: mở bước `Sn` và **đóng** bước hiện tại (chuyển bước). `ST Sn`: mở `Sn` nhưng **giữ** bước hiện tại (chạy song song). `RST Sn`: tắt bước.
- Mỗi `S` cũng có vô hạn tiếp điểm NO/NC, dùng được như rơ-le thường.
- Khi bước chuyển ON→OFF, các `OUT`, `PLS`, `PLF` và timer không tích lũy trong bước đó bị reset.

```ladder
NO:SM2 SET:S0
BOX:STL_S0
NO:SM0 OUT:Y0
NO:X0 SET:S1
BOX:STLE
```

#### `T`, `HT`, `ET` — Timer

**Là gì:** bộ định thời. Cộng dồn xung 1 ms, 10 ms hoặc 100 ms; đạt giá trị đặt thì **cuộn ra** (tiếp điểm `T0`) ON.

**Các loại:** `T0~T575` timer thường; `HT0~HT95` timer **tích lũy giữ khi mất điện**; `ET0~ET31` **timer chính xác** (chiếm tài nguyên phần cứng, xung đột với HSC và xuất xung, mục 4.9).

**Cú pháp:** `TMR Tn K<giá trị> K<đơn vị>` (không tích lũy), `TMR_A HTn …` (tích lũy).
- **Đơn vị chỉ được là `K1`, `K10`, `K100`** (1/10/100 ms). Ghi giá trị khác hoặc thanh ghi: vẫn tải xuống được nhưng **lệnh timer không chạy**.
- Giá trị đặt `K1~K32767` (hoặc thanh ghi `D`). Thời gian thực = giá trị × đơn vị. Ví dụ `K200 K10` = 2 s; dải 100 ms: 0,1 s ~ 3276,7 s.
- Giá trị hiện tại lưu ở thanh ghi `TD` (cùng số): `MOV T0 D0` ≡ `MOV TD0 D0`. Đếm tuyến tính 0…32767 rồi **dừng giữ nguyên**.
- Cùng một timer có thể dùng dạng tích lũy hay không tích lũy, chọn đơn vị bằng lệnh.
- `RST Tn` reset cả giá trị và cuộn ra.

```ladder
# Trễ tắt 2 s: X0 nhả, Y0 vẫn ON thêm 2 s
( NO:X0 / NO:Y0 ) NC:T2 OUT:Y0
NO:Y0 NC:X0 BOX:TMR_T2_K200_K10
# Nhấp nháy: tắt 2 s (T1), sáng 1 s (T2)
NO:X0 NC:T2 BOX:TMR_T1_K20_K10
NO:T1 BOX:TMR_T2_K10_K10
NO:T1 OUT:Y0
```

#### `C`, `HC`, `HSC` — Counter

**Là gì:** bộ đếm số lần chuyển **OFF→ON** của cuộn đếm.

**Các loại:** `C0~C575` thường (**mất giá trị khi tắt nguồn**); `HC0~HC95` **giữ giá trị và trạng thái khi mất điện**; `HSC0~HSC30` **counter tốc độ cao** (chỉ số chẵn, mỗi HSC chiếm hai thanh ghi; 16T có **3 kênh**).

**Điểm đặc biệt của XD:** loại counter (16/32-bit, đếm lên/xuống) do **lệnh** quyết định, không do tên phần tử:

| Lệnh | Kiểu | Giá trị đặt |
|---|---|---|
| `CNT Cn K` | 16-bit **đếm lên** | `K1~K32767` (`K0` và `K1` như nhau) |
| `CNT_D Cn K` | 16-bit **đếm xuống** | số âm, ví dụ `K-100` |
| `DCNT Cn K` | 32-bit **đếm lên** | đến `K2147483647` |
| `DCNT_D Cn K` | 32-bit **đếm xuống** | đến `K-2147483648` |

- **Reset:** `RST Cn` (16-bit), `DRST Cn` (32-bit): xoá giá trị và cuộn ra.
- **Hành vi khi chạm giới hạn:** 16-bit dừng ở 32767 / −32768 và giữ trạng thái; 32-bit **quay vòng** (2147483647 → −2147483648).
- 32-bit chiếm **hai thanh ghi**, địa chỉ phải là **số chẵn**.
- Giá trị hiện tại lưu ở `CD` (cùng số): `MOV C0 D0` ≡ `MOV CD0 D0`.
- Counter thường chỉ đếm được tần số thấp (**trên khoảng 25 Hz hãy dùng HSC**). HSC không bị ảnh hưởng bởi bộ lọc ngõ vào và chu kỳ quét; ví dụ `CNT HSC0 K888888` đếm xung ở `X0` khi `SM0` ON.

```ladder
NO:X10 RST:C0
NO:X11 BOX:CNT_C0_K10
NO:C0 OUT:Y0
# HC0: đếm xuống, giữ giá trị khi mất điện
NO:X3 RST:HC0
NO:X4 BOX:CNT__D_HC0_K-5
NO:HC0 OUT:Y1
```

#### `D`, `HD`, `SD`, `HSD` — Thanh ghi dữ liệu

**Là gì:** ô nhớ để lưu **số**. Mỗi thanh ghi 16-bit (bit cao nhất là bit dấu), −32768 ~ +32767. Hai thanh ghi liên tiếp ghép thành 32-bit (−2147483648 ~ 2147483647), thanh ghi thấp ở địa chỉ **chẵn**.

**Các loại:**
- `D0~D7999` — thường: ghi đè giá trị cũ, **bị xoá** khi PLC chuyển RUN↔STOP hoặc mất điện.
- `HD0~HD999` — **giữ** khi RUN→STOP và khi mất điện (vùng giữ cố định).
- `SD0~SD2047`, `HSD0~HSD499` — thanh ghi **đặc biệt** do hệ thống dùng (một số khởi tạo khi cấp điện). Không dùng cho mục đích khác.

**Dùng làm gì:** lưu số liệu, truyền dữ liệu (`MOV`), đọc giá trị timer/counter, **đặt giá trị cho timer/counter** (`TMR T0 D0 K10`, `CNT HC0 D4`), giao tiếp HMI/Modbus.

**Địa chỉ gián tiếp (offset):** `Dn[Dm]`, `Xn[Dm]`, `Yn[Dm]`, `Mn[Dm]` — địa chỉ thực = n + giá trị `Dm`. Ví dụ `MOV D10[D0] D100` với `D0=5` đọc `D15`; `Y0[D0]` với `D0=5` là `Y5`. Offset chỉ được là thanh ghi `D`. Rất tiện để quét mảng bằng `INC D0`.

```ladder
NO:X0 BOX:MOV_K10_D10
NO:X1 BOX:MOV_D10[D0]_D100
```

#### `FD`, `SFD`, `FS` — Thanh ghi Flash

**Là gì:** thanh ghi lưu trong **bộ nhớ Flash**, giữ dữ liệu khi mất điện **mà không cần pin**.
- `FD0~FD5119` — dữ liệu người dùng (thông số quan trọng của quy trình).
- `SFD0~SFD1999` — thông số **hệ thống**, không sửa tuỳ tiện.
- `FS0~FS47` — **bảo vệ bản quyền**: ghi được nhưng **đọc luôn ra 0**, chỉ so sánh với hằng số.

**Quy tắc ghi (quan trọng):**
- `MOV` vào FD/SFD/FS **chỉ có hiệu lực ở sườn lên**; chạy đúng một lần dù điều kiện là mức.
- Flash ghi được khoảng **1.000.000 lần**, mỗi lần xoá cả khối nên **chậm** (khoảng 150 ms). Ghi liên tục sẽ **hỏng Flash vĩnh viễn**.
- **Không** dùng xung dao động (`SM11`) làm điều kiện ghi; **không** dùng `SM0`, `SM2` làm điều kiện trực tiếp (nhiễu khi cấp điện) — nên ghi sau khi PLC chạy một lúc.
- Nếu giá trị nguồn không đổi so với lần ghi trước, lệnh **không chạy** dù điều kiện thoả lại.

#### `P` và `I` — Con trỏ

- `P0~P9999` (thập phân): **nhãn** cho `CJ Pn` (nhảy) và `CALL Pn` (chương trình con).
- `I`: **nhãn ngắt**. Trên XD3-16: ngắt ngoài `X2~X7` (`I0000`/`I0001` cho `X2` sườn lên/xuống, `I0100`/`I0101` cho `X3`… ), **ngắt timer** 20 cái `I40**~I59**` (`**` là thời gian, đơn vị ms), ngắt HSC, ngắt timer chính xác. Chương trình ngắt đặt sau `FEND` và kết thúc bằng `IRET`.

#### `K`, `H`, `B` — Hằng số và các hệ số

| Ký hiệu | Hệ số | Dùng cho |
|---|---|---|
| `K` | Thập phân (DEC) | Giá trị đặt timer/counter, toán hạng lệnh (`K10`) |
| `H` | Thập lục (HEX) | Toán hạng lệnh (`HA` = 10, `H1122`) |
| `B` | Nhị phân (BIN) | Toán hạng lệnh (`B10` = 2) |
| (bát phân) | OCT | Địa chỉ **X, Y** (X0~X7, X10~X17…) |
| BCD | Mã nhị phân thập phân | LED 7 đoạn, công tắc số (`BCD`/`BIN`) |
| Số thực | Float | Phép toán `E…`, `SIN/COS`… (tính nhị phân, hiển thị thập phân) |

Bên trong PLC mọi số xử lý ở dạng nhị phân; khi giám sát được đổi sang HEX/DEC.

#### `ID`, `QD` — Ngõ vào/ra analog (module/BD/ED)

`ID` (analog vào) và `QD` (analog ra) là địa chỉ thanh ghi của **mô-đun hoặc bo mở rộng**. Khi **không gắn** thiết bị mở rộng, các địa chỉ này dùng được như thanh ghi phụ. (XD3-16 không gắn được bo BD nên chỉ qua mô-đun/ED.)

**Quy tắc quan trọng**
- Dữ liệu 16-bit trong 1 thanh ghi: −32768 ~ 32767 (hoặc H0000~HFFFF).
- Dữ liệu **32-bit** chiếm 2 thanh ghi liên tiếp, thanh ghi thấp ở địa chỉ nhỏ (D10 thấp, D11 cao). Nên dùng địa chỉ chẵn cho thanh ghi thấp.
- Thêm chữ **`D`** trước tên lệnh để thành lệnh 32-bit: `ADD` → `DADD`, `MOV` → `DMOV`.
- Rơ-le đặc biệt thường dùng: `SM0` luôn ON, `SM2` xung ON một chu kỳ quét đầu khi chạy (khởi tạo), `SM11` xung dao động, `SM34` cấm toàn bộ ngõ ra. Cờ kết quả phép toán: **SM20** = kết quả bằng 0, **SM21** = mượn (borrow), **SM22** = nhớ (carry) — xem bảng trong từng lệnh số học của sổ tay.

## 2. Nguyên lý quét chương trình

PLC lặp: **đọc ngõ vào → thực hiện chương trình (trên xuống dưới, trái sang phải) → ghi ngõ ra**.

- Cuộn dây (`OUT`) lặp **hai lần** cho cùng một phần tử (dual coil): lần **cuối cùng** có hiệu lực. Nên tránh, hoặc gom điều kiện qua `M` trung gian rồi OUT một lần.
- Nên viết mạch có nhiều tiếp điểm nối tiếp ở phía trên, mạch nhiều nhánh song song ở bên trái để giảm số bước.
- `END` kết thúc chương trình; lệnh phía sau `END` không thực thi. Khi debug có thể chèn `END` để kiểm tra từng đoạn.

## 3. Lệnh cơ bản (basic instructions)

> **Khả dụng:** toàn bộ lệnh trong mục này dùng được trên XD3-16T-E (xem bảng ghi chú ở mục 4.9).

Toán hạng bit chung: `X, Y, M, HM, SM, S, HS, T, HT, C, HC, Dn.m` (bit thứ m của thanh ghi Dn).

### 3.1 Bảng tổng hợp

| Lệnh | Chức năng |
|---|---|
| `LD` / `LDI` | Bắt đầu mạch bằng tiếp điểm thường mở (NO) / thường đóng (NC) |
| `AND` / `ANI` | Nối **tiếp** tiếp điểm NO / NC |
| `OR` / `ORI` | Nối **song song** tiếp điểm NO / NC |
| `ANB` | Nối tiếp hai khối song song |
| `ORB` | Nối song song hai khối nối tiếp |
| `OUT` | Xuất ra cuộn dây (Y, M, S, T, C…) — **không dùng cho X** |
| `SET` / `RST` | Đặt lên 1 / xoá về 0 có chốt; `RST` còn dùng reset timer, counter |
| `LDP` / `ANDP` / `ORP` | Tiếp điểm **sườn lên** (OFF→ON), ON trong đúng 1 chu kỳ quét |
| `LDF` / `ANDF` / `ORF` | Tiếp điểm **sườn xuống** (ON→OFF), ON trong 1 chu kỳ quét |
| `LDD` `LDDI` `ANDD` `ANDDI` `ORD` `ORDI` | Như LD/AND/OR nhưng với `X` thì **đọc trực tiếp từ đầu vào** (không đợi quét) |
| `OUTD` | Xuất ra `Y` **ngay lập tức** (không đợi hết chu kỳ quét) |
| `PLS` / `PLF` | Tạo xung 1 chu kỳ quét khi điều kiện sườn lên / sườn xuống |
| `ALT` | Đảo trạng thái phần tử mỗi lần có xung điều khiển (toggle) |
| `MCS` / `MCR` | Điều khiển chủ: bắt đầu / kết thúc đường bus chung; lồng tối đa **10 cấp**, phải đi cặp |
| `TMR` / `TMR_A` | Timer thường / timer tích lũy giữ khi mất điện |
| `CNT` `CNT_D` `DCNT` `DCNT_D` | Counter 16-bit (`CNT`, `CNT_D`) / 32-bit (`DCNT`, `DCNT_D`); **chữ `_D` = đếm xuống**. Giữ khi mất điện hay không do **loại phần tử** quyết định: `C` thường, `HC` giữ điện |
| `END` | Kết thúc chương trình |
| `GROUP` / `GROUPE` | Nhóm chương trình để thu gọn/mở rộng trong editor (không ảnh hưởng chạy) |

### 3.2 LD, LDI, OUT

```
LD   X0        ; tiếp điểm NO X0 nối thanh cái
OUT  Y0        ; cuộn Y0
LDI  X1        ; tiếp điểm NC X1
OUT  M1203
```

**Hình ladder — LD / LDI / OUT:**

```ladder
# LD X0 / OUT Y0
NO:X0 OUT:Y0
# LDI X1 / OUT M1203
NC:X1 OUT:M1203
```

`LD/LDI` nối trực tiếp thanh cái trái hoặc đầu nhánh. `OUT` có thể nối tiếp thành "follow-on output" (xuất nối chuỗi):
```
LD  X2
AND M1
OUT Y2
LD  Y2
ANI X3
OUT M2
AND T1
OUT Y3        ; Y3 = Y2 · ¬X3 · T1
```

**Hình ladder — xuất nối chuỗi:**

```ladder
# M2 = Y2·¬X3, sau đó Y3 = M2·T1
NO:Y2 NC:X3 OUT:M2
NO:Y2 NC:X3 NO:T1 OUT:Y3
```


### 3.3 OR, ORI và khối ORB/ANB

```
LD  X5
OR  X6
OR  M11
OUT Y6              ; Y6 = X5 + X6 + M11
```

**Hình ladder — OR:**

```ladder
# Y6 = X5 + X6 + M11
( NO:X5 / NO:X6 / NO:M11 ) OUT:Y6
```

Hai chuỗi nối tiếp song song nhau:
```
LD  X0
AND X1
LD  X2
AND X3
ORB                 ; (X0·X1) + (X2·X3)
OUT Y10
```

**Hình ladder — ORB:**

```ladder
# (X0·X1) + (X2·X3)
( NO:X0 NO:X1 / NO:X2 NO:X3 ) OUT:Y10
```

Hai khối song song nối tiếp nhau:
```
LD  X0
OR  X1
LD  X2
AND X3
LDI X4
AND X5
ORB
OR  X6
ANB                 ; (X0+X1) · ((X2·X3)+(¬X4·X5)+X6)
OR  X7
OUT Y20
```

**Hình ladder — ANB + OR:**

```ladder
# ((X0+X1) · ((X2·X3) + (¬X4·X5) + X6)) + X7
( ( NO:X0 / NO:X1 ) ( NO:X2 NO:X3 / NC:X4 NO:X5 / NO:X6 ) / NO:X7 ) OUT:Y20
```

Nên viết `ORB` ngay sau từng cặp khối (cách viết gọn), tránh dồn nhiều `LD` rồi mới `ORB` hàng loạt.

### 3.4 Tiếp điểm sườn: LDP, LDF, ANDP, ANDF, ORP, ORF

```
LDP  X5      ; bắt sườn lên X5
ORP  X6
OUT  M13     ; M13 ON 1 chu kỳ quét khi X5 hoặc X6 vừa được nhấn
LD   SM0
ANDP X7
OUT  M15
```

**Hình ladder — LDP / ORP / ANDP:**

```ladder
# LDP X5 / ORP X6 / OUT M13
( P:X5 / P:X6 ) OUT:M13
# LD SM0 / ANDP X7 / OUT M15
NO:SM0 P:X7 OUT:M15
# LDF X8: sườn xuống
N:X8 OUT:M16
```

Dùng khi cần **một lần** tác động cho mỗi lần nhấn nút (đếm, đảo trạng thái, SET/RST…).

### 3.5 SET / RST — tự giữ

```
LD  X10
SET Y0        ; X10 nhấn 1 lần → Y0 giữ ON
LD  X11
RST Y0        ; X11 nhấn → Y0 OFF
```

**Hình ladder — SET / RST:**

```ladder
# SET / RST có chốt
NO:X10 SET:Y0
NO:X11 RST:Y0
```

- `SET/RST` dùng nhiều lần cho cùng một phần tử, **lệnh nằm sau cùng có hiệu lực**.
- **Không** dùng `OUT` cùng phần tử với `SET/RST`.
- `RST T0` / `RST C0` xoá giá trị hiện tại và cuộn ra của timer/counter.

**Hình ladder — RST timer/counter:**

```ladder
NO:X16 BOX:TMR_T250_K10_K10
NO:X17 RST:T250
```

Mạch tự giữ kinh điển (start/stop):
```
LD  X0          ; nút Start
OR  Y0          ; tự giữ
ANI X1          ; nút Stop (NC logic)
OUT Y0
```

**Hình ladder — Start/Stop tự giữ:**

```ladder
# LD X0 / OR Y0 / ANI X1 / OUT Y0
( NO:X0 / NO:Y0 ) NC:X1 OUT:Y0
```


### 3.6 PLS / PLF / ALT

```
LD  X0
PLS M0          ; M0 ON một chu kỳ khi X0 lên
LD  M0
SET Y0

LD  X1
PLF M1          ; M1 ON một chu kỳ khi X1 xuống
LD  M1
RST Y0
```

**Hình ladder — PLS / PLF:**

```ladder
# PLS: M0 ON một chu kỳ khi X0 lên
NO:X0 BOX:PLS_M0
NO:M0 SET:Y0
# PLF: M1 ON một chu kỳ khi X1 xuống
NO:X1 BOX:PLF_M1
NO:M1 RST:Y0
```

`ALT` (bật/tắt bằng một nút):
```
LDP M100
ALT M0          ; mỗi lần M100 lên, M0 đảo trạng thái
LD  M0
OUT Y0
LDI M0
OUT Y1
```

**Hình ladder — ALT:**

```ladder
# Mỗi lần M100 lên, M0 đảo trạng thái
P:M100 BOX:ALT_M0
NO:M0 OUT:Y0
NC:M0 OUT:Y1
```


### 3.7 MCS / MCR (master control)

```
LD  X1
MCS             ; bus mới bắt đầu, điều kiện X1
LD  X2
OUT Y0          ; chỉ hoạt động khi X1 = ON
LD  M1
MCS             ; lồng cấp 2
LD  M3
OUT Y1
MCR
MCR             ; kết thúc đủ 2 cấp
```

**Hình ladder — MCS / MCR:**

```ladder
# MCS / MCR lồng hai cấp
NO:X1 BOX:MCS
NO:X2 OUT:Y0
NO:M1 BOX:MCS
NO:M3 OUT:Y1
NO:M2 OUT:Y2
BOX:MCR
BOX:MCR
```

Trong phần mềm XDPPro, MCS/MCR **không** nhập trực tiếp ở dạng ladder — vẽ bằng đường ngang/dọc.

### 3.8 TMR / TMR_A — Timer

**Cú pháp:** `TMR  Tn  <giá trị đặt>  <đơn vị thời gian>`

- Đơn vị thời gian: **K1 = 1 ms, K10 = 10 ms, K100 = 100 ms**.
- Thời gian thực = giá trị đặt × đơn vị. Ví dụ `TMR T0 K200 K10` = 200×10 ms = **2 giây**.
- Giá trị đặt có thể là hằng `K` hoặc thanh ghi `D`.
- `TMR`: timer thường (T), khi điều kiện OFF thì **reset**.
- `TMR_A`: timer tích lũy (HT), khi điều kiện OFF thì **giữ giá trị**, ON lại thì tính tiếp; **xoá bằng `RST HT0`**; giữ cả khi mất điện.

```
LD  M0
TMR T0 K10 K100     ; trễ 1 giây (10 × 100 ms)
LD  T0
OUT Y0
LD  M1
RST T0              ; reset cưỡng bức
```

**Hình ladder — TMR:**

```ladder
# TMR T0 K10 K100: trễ 1 s, reset bằng M1
NO:M0 BOX:TMR_T0_K10_K100
NO:T0 OUT:Y0
NO:M1 RST:T0
```

Đặt thời gian gián tiếp:
```
LD  X1
MOV K10 D0
LD  X0
TMR T0 D0 K10       ; giá trị đặt lấy từ D0
```

**Hình ladder — TMR đặt giá trị gián tiếp:**

```ladder
# Giá trị đặt lấy từ D0
NO:X1 BOX:MOV_K10_D0
NO:X0 BOX:TMR_T0_D0_K10
```

Tích lũy:
```
LD  X0
TMR_A HT0 K2000 K10 ; 20 s tích lũy
LD  X2
RST HT0
```

**Hình ladder — TMR_A tích lũy:**

```ladder
# TMR_A: tích lũy 20 s, reset bằng X2
NO:X0 BOX:TMR__A_HT0_K2000_K10
NO:HT0 OUT:Y1
NO:X2 RST:HT0
```


### 3.9 CNT / DCNT — Counter

- `CNT Cn K` — đếm **lên** 16-bit; `CNT_D Cn K` — đếm **xuống** 16-bit (giá trị đặt âm, ví dụ `K-100`).
- `DCNT` — đếm lên 32-bit; `DCNT_D` — đếm xuống 32-bit.
- **Giữ khi mất điện** do chọn phần tử: dùng `C` (thường, mất giá trị khi tắt nguồn) hoặc `HC` (giữ giá trị và trạng thái cuộn). Không phụ thuộc chữ `_D`.
- Mỗi lần cuộn đếm chuyển **OFF→ON** là +1; chạm giá trị đặt thì cuộn counter ON, sau đó vẫn tiếp tục tăng.
- **Reset** bằng `RST Cn`.

```
LD  X10
RST C0
LD  X11
CNT C0 K10          ; đếm xung X11, đủ 10 thì C0 ON
LD  C0
OUT Y0
```

**Hình ladder — CNT:**

```ladder
# CNT: đếm xung X11, reset bằng X10
NO:X10 RST:C0
NO:X11 BOX:CNT_C0_K10
NO:C0 OUT:Y0
# DCNT với HC0: đếm lên 32-bit, giữ khi mất điện
NO:X12 BOX:DCNT_HC0_K100000
```


### 3.10 Đối chiếu ladder ↔ C++ (lệnh cơ bản)

Ladder chạy trong **vòng quét** (đọc X → chạy chương trình trên xuống dưới → ghi Y), nên khi quy sang C++ ta mô phỏng bằng một vòng lặp. Quy ước dùng trong các ví dụ dưới đây:

```cpp
bool X[16], Y[16], M[8000], S[1000];   // bit: ngõ vào, ngõ ra, trung gian, bước
int16_t D[8000];                       // thanh ghi 16-bit (DMOV/DADD... = int32_t)
bool X0_prev;                          // trạng thái chu kỳ quét trước — để bắt sườn

while (true) {                         // = vòng quét của PLC
    readInputs();                      // đọc chân X vào vùng ảnh
    /* ... chương trình ladder, trên xuống dưới, trái sang phải ... */
    writeOutputs();                    // ghi vùng ảnh ra chân Y thật
}
```

**Tiếp điểm và đường nối (điều kiện)**

| Hình / lệnh | C++ | Ghi chú |
|---|---|---|
| Thường mở `LD X0` / `AND X0` / `OR X0` | `X0` | `LD` mở đầu biểu thức, `AND` thành `&&`, `OR` thành `\|\|` |
| Thường đóng `LDI X0` / `ANI X0` / `ORI X0` | `!X0` | Như trên nhưng đảo |
| Sườn lên `LDP` / `ANDP` / `ORP` | `X0 && !X0_prev` | Phải tự lưu `X0_prev`; cuối mỗi vòng quét gán `X0_prev = X0;` |
| Sườn xuống `LDF` / `ANDF` / `ORF` | `!X0 && X0_prev` | |
| Nối tiếp (đường ngang) | `a && b` | |
| Song song (đường dọc, nhánh trên/dưới) | `a \|\| b` | |
| `ANB` (nối tiếp hai khối) | `(a \|\| b) && (c \|\| d)` | Dấu ngoặc chính là "khối" |
| `ORB` (song song hai khối) | `(a && b) \|\| (c && d)` | |
| `LDD` `LDDI` `ANDD` `ANDDI` `ORD` `ORDI` | `readPinNow(X0)` | Đọc **thẳng chân vào**, không dùng vùng ảnh `X[]` |

**Cuộn dây (kết quả)**

| Hình / lệnh | C++ | Ghi chú |
|---|---|---|
| Cuộn xuất `OUT Y0` | `Y0 = dieu_kien;` | Luôn bám theo mạch, mất dẫn thì tắt |
| Cuộn đặt `SET Y0` | `if (dieu_kien) Y0 = true;` | Có nhớ |
| Cuộn reset `RST Y0` | `if (dieu_kien) Y0 = false;` | Cặp với `SET`; dòng nằm dưới thắng |
| `OUTD Y0` | `if (dieu_kien) writePinNow(Y0, true);` | Ghi **thẳng chân ra**, không đợi hết chu kỳ quét |
| `PLS M0` | `M0 = dieu_kien && !dk_prev;` | `M0` ON đúng 1 chu kỳ quét khi điều kiện lên |
| `PLF M0` | `M0 = !dieu_kien && dk_prev;` | Khi điều kiện xuống |
| `ALT M0` | `if (dieu_kien) M0 = !M0;` | Đảo trạng thái (toggle); thường đi với điều kiện sườn lên |
| `END` | `break;` / kết thúc thân vòng lặp | Phần sau `END` không chạy |
| `GROUP` / `GROUPE` | chú thích `// ---` hoặc `#pragma region` | Chỉ để gom nhóm trong editor, không ảnh hưởng chạy |

**Điều khiển chủ, timer, counter**

| Hình / lệnh | C++ | Ghi chú |
|---|---|---|
| `MCS` … `MCR` | `if (X1) { /* các dòng bên trong */ }` | Lồng tối đa 10 cấp = `if` lồng nhau. Khi `X1` = OFF, các `OUT` bên trong về OFF |
| `TMR T0 K10 K100` | xem ví dụ dưới | Trễ 10 × 100 ms = 1 s; điều kiện OFF thì reset |
| `TMR_A HT0 K2000 K10` | xem ví dụ dưới | Tích lũy: OFF thì **giữ**, chỉ `RST HT0` mới xoá |
| `CNT C0 K10` (16-bit lên) | `int16_t` đếm sườn lên | Đủ giá trị đặt thì `C0` ON, vẫn đếm tiếp |
| `CNT_D C0 K-10` (16-bit xuống) | `count--` | Giá trị đặt âm |
| `DCNT` / `DCNT_D` (32-bit) | `int32_t count` | Chữ `_D` = đếm xuống |
| `RST C0` / `RST T0` | `count = 0; C0 = false;` | Xoá cả giá trị lẫn cuộn ra |

Ví dụ `TMR` / `TMR_A` (cho vòng quét gọi mỗi chu kỳ, `now_ms()` là đồng hồ ms):

```cpp
// TMR T0 K10 K100 : NO:M0 → sau 1 s thì T0 ON
static uint32_t t0_start; static bool t0_run = false;
if (M0) {
    if (!t0_run) { t0_run = true; t0_start = now_ms(); }
    T0 = (now_ms() - t0_start >= 10 * 100);
} else { t0_run = false; T0 = false; }          // điều kiện OFF → reset

// TMR_A HT0 K2000 K10 : tích lũy 20 s, giữ khi X0 tắt, xoá bằng X2
static uint32_t ht0_acc = 0, ht0_last = now_ms();
uint32_t t = now_ms();
if (X0) ht0_acc += t - ht0_last;                // chỉ cộng dồn khi X0 ON
ht0_last = t;
HT0 = (ht0_acc >= 2000 * 10);
if (X2) { ht0_acc = 0; HT0 = false; }           // RST HT0
```

Ví dụ `CNT`:

```cpp
// CNT C0 K10 : đếm sườn lên X11, reset bằng X10
static int16_t c0 = 0;
if (X10) { c0 = 0; C0 = false; }                // RST C0
if (X11 && !X11_prev) c0++;                     // OFF→ON là +1
C0 = (c0 >= 10);
X11_prev = X11;
```

Ví dụ tự giữ và `SET`/`RST`:

```cpp
Y0 = (X0 || Y0) && !X1;                         // ( NO:X0 / NO:Y0 ) NC:X1 OUT:Y0
if (X10) Y1 = true;                             // NO:X10 SET:Y1
if (X11) Y1 = false;                            // NO:X11 RST:Y1 (nằm dưới → Stop thắng)
```

Khác biệt cần nhớ: PLC tự có vòng quét, tự bắt sườn và tự ghi `Y` ra chân sau khi chạy hết chương trình; trong C++ phải tự viết `while`, tự lưu giá trị chu kỳ trước (`_prev`) và tự gọi `writeOutputs()`.

## 4. Lệnh ứng dụng (applied instructions)

> **Khả dụng:** sổ tay ghi mọi lệnh bên dưới là *XD, XL* — dùng được trên XD3-16T-E. Giới hạn chủ yếu ở phần cứng (xung chỉ Y0/Y1, 3 kênh HSC, ngắt X2~X7); RTC và số cổng truyền thông chưa xác nhận — xem **mục 4.9**.

**Cách đọc:** `S` = nguồn (không đổi), `D` = đích (bị ghi), `n` = số lượng. Lệnh có chữ `D` đứng đầu là bản 32-bit (ví dụ `DMOV`, `DADD`). Điều kiện thực thi: mức (liên tục mỗi chu kỳ) hoặc sườn (dùng `LDP` để chỉ chạy 1 lần).

> **Lưu ý:** với lệnh số học/truyền, nếu để điều kiện ON liên tục, lệnh chạy lại **mỗi chu kỳ quét**. Muốn chạy 1 lần, dùng `LDP`/`PLS` làm điều kiện.

### 4.1 Điều khiển luồng chương trình

| Lệnh | Cú pháp | Chức năng |
|---|---|---|
| `CJ` | `CJ Pn` | Nhảy tới nhãn `Pn` (rút ngắn chu kỳ quét, tránh dual coil). Không nhảy từ STL này sang STL khác. Nhãn `Pn` phải khớp |
| `CALL` | `CALL Pn` | Gọi chương trình con tại nhãn `Pn` (đặt **sau `FEND`**) |
| `SRET` | `SRET` | Kết thúc chương trình con, quay về |
| `FEND` | `FEND` | Kết thúc chương trình chính (sau đó là chương trình con/ngắt) |
| `END` | `END` | Kết thúc toàn chương trình |
| `FOR` / `NEXT` | `FOR n` … `NEXT` | Lặp đoạn giữa FOR và NEXT n lần |
| `STL` / `STLE` | `STL Sn` … `STLE` | Mở đầu / kết thúc một bước (flow); mỗi flow độc lập, không lồng nhau |
| `SET Sn` | `SET Sn` | Mở flow `Sn`, **đóng** flow hiện tại (chuyển bước) |
| `ST Sn` | `ST Sn` | Mở flow `Sn`, **giữ** flow hiện tại (chạy song song) |

**Hình ladder — FOR / NEXT:**

```ladder
NO:X1 BOX:FOR_K5
NO:SM0 BOX:INC_D1
BOX:NEXT
```

**Hình ladder — CJ (nhảy):**

```ladder
# CJ: nhảy tới nhãn P6 khi X0 = ON
NO:X0 BOX:CJ_P6
NO:X1 OUT:Y0
BOX:P6
```

Ví dụ chương trình con:
```
LD   X0
CALL P10        ; gọi chương trình con
FEND            ; hết chương trình chính
P10
...             ; nội dung chương trình con
SRET
END
```

**Hình ladder — CALL / SRET / FEND / END:**

```ladder
NO:X0 BOX:CALL_P10
BOX:FEND
BOX:P10
NO:SM0 BOX:INC_D0
BOX:SRET
BOX:END
```

- Cho phép lồng gọi chương trình con (tối đa 10 cấp, gồm lần gọi gốc).
- Không viết timer/bộ đếm chạy dài nhiều chu kỳ quét trong chương trình con.
- Chương trình ngắt (`Ixxxx`) đặt sau `FEND` và kết thúc bằng `IRET`.

Điều khiển tuần tự bằng flow (STL):
```
LD  SM2
SET S0                 ; bắt đầu ở bước S0
STL S0
  LD  SM0
  OUT Y0               ; Y0 ON trong bước S0
  LD  X0
  SET S1               ; sang bước S1, S0 tự đóng
STLE
STL S1
  LD  SM0
  OUT Y1
  TMR T0 K50 K100      ; chờ 5 s
  LD  T0
  SET S0               ; quay lại
STLE
```

**Hình ladder — STL / STLE / SET Sn:**

```ladder
# Chuyển bước S0 -> S1
NO:SM2 SET:S0
BOX:STL_S0
NO:SM0 OUT:Y0
NO:X0 SET:S1
BOX:STLE
```

Khi flow chuyển ON→OFF, các `OUT`, `PLS`, `PLF`, timer không tích lũy trong flow đó bị reset.

### 4.2 So sánh dữ liệu dạng tiếp điểm

`LD`, `AND`, `OR` + toán tử so sánh `= > < >= <= <>` (viết sau tên lệnh), với 2 toán hạng `S1`, `S2` (có bản 32-bit thêm `D`). Điều kiện thoả thì "tiếp điểm" dẫn.

```
LD>  D0 K100        ; D0 > 100
OUT  Y0
LD   X0
AND= D1 D2          ; X0 và D1 = D2
OUT  Y1
```

**Hình ladder — tiếp điểm so sánh:**

```ladder
CMP:LD>_D0_K100 OUT:Y0
NO:X0 CMP:AND=_D1_D2 OUT:Y1
( CMP:LD<_D0_K10 / CMP:LD>_D0_K90 ) OUT:Y2
```


### 4.3 Truyền và so sánh dữ liệu

| Lệnh | Cú pháp | Chức năng |
|---|---|---|
| `CMP` | `CMP S1 S2 D` | So sánh S1 với S2, xuất kết quả ra 3 bit liên tiếp `D, D+1, D+2` (S1>S2, S1=S2, S1<S2). Khi lệnh ngưng, 3 bit giữ nguyên |
| `ZCP` | `ZCP S1 S2 S D` | So sánh S với vùng [S1, S2]; kết quả vào `D…D+2` (S<S1, trong vùng, S>S2) |
| `MOV` | `MOV S D` | Chép 1 dữ liệu 16-bit (`DMOV` 32-bit) |
| `BMOV` | `BMOV S D n` | Chép khối n thanh ghi |
| `PMOV` | `PMOV S D n` | Chép khối (tốc độ nhanh hơn) |
| `FMOV` | `FMOV S D n` | Điền cùng một giá trị vào n thanh ghi |
| `EMOV` | `EMOV S D` | Chép số thực |
| `FWRT` | `FWRT S D` | Ghi vào Flash ROM (FD/SFD) |
| `MSET` | `MSET S1 S2` | Set nhiều bit trong vùng |
| `ZRST` | `ZRST S1 S2` | Reset (xoá) vùng từ S1 đến S2 |
| `SWAP` | `SWAP S` | Đổi chỗ byte cao/thấp |
| `XCH` | `XCH D1 D2` | Hoán đổi hai giá trị |

**Hình ladder — CMP, ZCP, BMOV, FMOV (dưới bảng):**

```ladder
# CMP: kết quả vào M0 (>), M1 (=), M2 (<)
NO:X0 BOX:CMP_D10_D20_M0
# ZCP: so sánh D0 với vùng [D20, D30]
NO:X1 BOX:ZCP_D20_D30_D0_M0
NO:X3 BOX:BMOV_D0_D100_K10
NO:X4 BOX:FMOV_K0_D200_K20
```

```
LD   X0
MOV  K10 D10            ; D10 = 10
LD   X1
MOV  T0 D20             ; đọc giá trị hiện tại của timer T0
LD   X2
DMOV HSC0 D30           ; đọc giá trị counter tốc độ cao (32-bit)
LD   X3
ZRST M0 M99             ; xoá M0..M99
```

**Hình ladder — MOV / DMOV / ZRST:**

```ladder
NO:X0 BOX:MOV_K10_D10
NO:X1 BOX:MOV_T0_D20
NO:X2 BOX:DMOV_HSC0_D30
NO:X3 BOX:ZRST_M0_M99
```


### 4.4 Phép toán số học và logic

| Lệnh | Cú pháp | Công thức |
|---|---|---|
| `ADD` / `DADD` | `ADD S1 S2 D` | D = S1 + S2 |
| `SUB` | `SUB S1 S2 D` | D = S1 − S2 |
| `MUL` | `MUL S1 S2 D` | D = S1 × S2 (kết quả 32-bit chiếm 2 thanh ghi) |
| `DIV` | `DIV S1 S2 D` | D = thương, D+1 = số dư; **chia cho 0 là lỗi** |
| `INC` / `DEC` | `INC D` | D = D ± 1 |
| `MEAN` | `MEAN S D n` | D = trung bình n thanh ghi bắt đầu từ S |
| `WAND` / `WOR` / `WXOR` | `WAND S1 S2 D` | AND / OR / XOR theo từng bit |
| `CML` | `CML S D` | Đảo bit |
| `NEG` | `NEG D` | Đổi dấu (bù 2) |

**Hình ladder — MUL, WAND (dưới bảng):**

```ladder
NO:X5 BOX:MUL_D10_D12_D14
NO:X6 BOX:WAND_D0_H00FF_D1
```

- Dấu: bit cao nhất là bit dấu; phép toán đại số, ví dụ 5 + (−8) = −3.
- Cờ: **SM20** = kết quả 0, **SM21** = mượn, **SM22** = nhớ. Tràn dải 16-bit/32-bit làm tác động cờ.
- Nguồn và đích có thể là cùng một thanh ghi.

```
LD  X0
ADD D10 D12 D14          ; D14 = D10 + D12
LD  X1
DDIV D0 D2 D4            ; 32-bit: (D1D0)/(D3D2) → thương (D5D4), dư (D7D6)
LDP X2
INC D100                 ; mỗi lần X2 lên: +1
```

**Hình ladder — ADD / DDIV / INC:**

```ladder
NO:X0 BOX:ADD_D10_D12_D14
NO:X1 BOX:DDIV_D0_D2_D4
P:X2 BOX:INC_D100
```


### 4.5 Dịch và xoay bit/word

| Lệnh | Cú pháp | Chức năng |
|---|---|---|
| `SHL` / `SHR` | `SHL D n` | Dịch số học trái/phải n bit |
| `LSL` / `LSR` | `LSL D n` | Dịch logic trái/phải |
| `ROL` / `ROR` | `ROL D n` | Xoay trái/phải |
| `SFTL` / `SFTR` | `SFTL S D n1 n2` | Dịch bit trái/phải trong chuỗi bit dài n1, dịch n2 bit |
| `WSFL` / `WSFR` | `WSFL S D n1 n2` | Dịch word trái/phải |

**Hình ladder — SHL, ROL, SFTL:**

```ladder
NO:X0 BOX:SHL_D0_K2
NO:X1 BOX:ROL_D0_K1
NO:X2 BOX:SFTL_M0_M10_K8_K1
```

### 4.6 Chuyển đổi dữ liệu

| Lệnh | Chức năng |
|---|---|
| `WTD S D` | Số nguyên 16-bit → 32-bit |
| `FLT` / `DFLT` / `FLTD` | Nguyên 16 / 32 / 64-bit → số thực |
| `INT S D` | Số thực → nguyên |
| `BIN S D` / `BCD S D` | BCD ↔ nhị phân (dùng với đèn LED 7 đoạn, công tắc số) |
| `ASCI S D n` / `HEX S D n` | Hex ↔ ASCII |
| `DECO S D n` | Giải mã (n bit → 1 trong 2ⁿ) |
| `ENCO S D n` / `ENCOL S D n` | Mã hoá theo bit cao nhất / thấp nhất đang ON |
| `GRY S D` / `GBIN S D` | Nhị phân ↔ mã Gray (cho encoder tuyệt đối) |

**Hình ladder — BCD, FLT, DECO:**

```ladder
NO:SM0 BOX:BCD_D0_D10
NO:X0 BOX:FLT_D0_D20
NO:X1 BOX:DECO_D0_M0_K3
```

### 4.7 Số thực (floating point)

`ECMP`, `EZCP` (so sánh); `EADD`, `ESUB`, `EMUL`, `EDIV` (cộng/trừ/nhân/chia); `ESQR` (căn bậc hai); `SIN`, `COS`, `TAN`, `ASIN`, `ACOS`, `ATAN`. Số thực 32-bit chiếm 2 thanh ghi.

Ví dụ tính nhiệt độ từ giá trị ADC: `FLT D0 D10` → `EMUL D10 E0.1 D12` → `EADD D12 E-20.0 D14`.

**Hình ladder — số thực:**

```ladder
NO:X0 BOX:FLT_D0_D10
NO:SM0 BOX:EMUL_D10_E0.1_D12
NO:SM0 BOX:EADD_D12_E-20.0_D14
```

### 4.8 Đồng hồ thời gian thực (RTC)

`TRD D` đọc đồng hồ vào 7 thanh ghi liên tiếp; `TWR D` ghi đồng hồ; `TCMP` so sánh thời gian.

**Hình ladder — TRD:**

```ladder
NO:SM0 BOX:TRD_D0
```

### 4.9 Khả dụng trên XD3-16T-E — ghi chú hỗ trợ / giới hạn

> **Kết luận từ sổ tay:** mọi lệnh cơ bản (mục 3) và lệnh ứng dụng (mục 4) trong tài liệu này đều ghi *Suitable Models: XD, XL* — **không có lệnh nào bị loại trừ riêng cho XD3**. Giới hạn của XD3-16T-E nằm ở **phần cứng và tài nguyên** (số I/O, kênh xung, kênh HSC, ngắt), không phải ở tập lệnh. Một vài mục dưới đây tôi **không xác nhận được** từ sổ tay và ghi rõ để bạn kiểm tra thêm.

| Nhóm lệnh / chức năng | Trạng thái trên XD3-16T-E | Ghi chú |
|---|---|---|
| Lệnh cơ bản: `LD/AND/OR/OUT/SET/RST/PLS/PLF/ALT/MCS/MCR/TMR/CNT/END` | ✅ Có | Dải phần tử: M0~M69999, T0~T575, C0~C575, D0~D7999… (mục 1) |
| Luồng: `CJ`, `CALL/SRET`, `FOR/NEXT`, `STL/STLE`, `SET/ST Sn` | ✅ Có | CALL lồng tối đa 10 cấp |
| So sánh, truyền (`CMP`, `ZCP`, `MOV`, `BMOV`, `FMOV`…) | ✅ Có | |
| Số học, logic, dịch, chuyển đổi (`ADD…NEG`, `SHL…WSFR`, `BCD`, `DECO`…) | ✅ Có | Bản 32-bit thêm tiền tố `D` |
| Số thực (`E…`, `SIN/COS…`) | ✅ Có | |
| `FWRT` (ghi Flash) | ✅ Có, **hạn chế sử dụng** | Mất ~150 ms mỗi lần ghi, tuổi thọ ~1.000.000 lần; luôn kích bằng sườn (`LDP`) |
| Timer chính xác `ET0~ET31` | ✅ Có | **Xung đột tài nguyên** với HSC và xuất xung (xem dưới) |
| Counter tốc độ cao (HSC) | ✅ Có, **3 kênh** | HSC0: 80 kHz một pha / 50 kHz AB; HSC2, HSC4: 10 kHz một pha / 5 kHz AB. Ngõ vào X0.. dùng làm xung thì không dùng được làm ngõ vào thường |
| Xuất xung / PWM | ✅ Có, **chỉ Y0 và Y1** | Cần ngõ ra transistor (`T`, đúng với 16T). PWM tối đa 100 kHz. Không có Y2, Y3 như XD2/XD5 → **tối đa 2 trục** |
| Ngắt ngoài `Ixxxx` | ✅ Có, **6 ngõ: X2~X7** | Ngắt sườn lên/xuống; timer ngắt 20 cái (I40**~I59**) |
| RTC: `TRD`, `TWR`, `TCMP` | ⚠️ **Chưa xác nhận** | Lệnh thuộc XD/XL nhưng sổ tay lệnh không nói XD3-16 có đồng hồ phần cứng hay không. Thử `TRD` khi chạy, hoặc xem *hardware manual* / nhãn máy |
| Truyền thông (Modbus RTU/ASCII, X-NET, `SEND/RCV`) | ✅ Lệnh có; ⚠️ **số cổng/kiểu cổng tuỳ model** | XD3-16T-E có USB và cổng nối tiếp; số cổng COM chính xác xem Phụ lục 5 / hardware manual. Hậu tố **E** chưa xác nhận (có thể liên quan Ethernet/RJ45) |
| PID, khối hàm C, BLOCK | ✅ Không thấy hạn chế riêng cho XD3 | Nhưng kiểm tra dung lượng/phiên bản XDPPro |
| Mô-đun mở rộng, BD, ED | Mô-đun: ✅ tối đa 10; BD: ❌ không hỗ trợ (PLC 16 điểm); ED: ⚠️ chưa xác nhận | Chi tiết xem bảng phần tử mềm (mục 1) |

**Xung đột tài nguyên (XD3-16):** ET (timer chính xác), HSC và xuất xung Y0/Y1 dùng chung một số kênh phần cứng; **hai tài nguyên cùng một hàng trong bảng xung đột (Appendix 4) không được dùng đồng thời**. Ví dụ: ET8 trùng HSC0; ET10 trùng HSC2; ET12 trùng HSC4; ET14, ET16 trùng Y0; ET18, ET20 trùng Y1.

**Cách kiểm tra chắc chắn:** trong XDPPro chọn đúng model **XD3-16T** (hoặc XD3-16T-E nếu có) rồi biên dịch; lệnh/tài nguyên không hỗ trợ sẽ báo lỗi. Hoặc đối chiếu *XD/XL hardware manual* và Phụ lục 4, 5 của sổ tay lệnh.

### 4.10 Đối chiếu lệnh ứng dụng ↔ C++

Dùng cùng quy ước với mục 3.10 (`D[]` là `int16_t`, bản 32-bit `Dxxx` dùng `int32_t` ghép hai thanh ghi liền nhau). Mỗi lệnh chỉ chạy khi **điều kiện dẫn**: viết `if (dieu_kien) { ... }` bao quanh; muốn chạy 1 lần thì điều kiện là sườn lên (`X0 && !X0_prev`).

**Luồng chương trình (4.1)**

| Lệnh | C++ | Ghi chú |
|---|---|---|
| `CJ Pn` | `if (dk) goto Pn;` | Nhảy tới nhãn `Pn:` |
| `CALL Pn` … `SRET` | `pn();` … `return;` | `Pn` là hàm con, đặt sau `FEND` |
| `FEND` | hết thân `main`/vòng quét | Sau đó là chương trình con và ngắt |
| `END` | `break;` | Kết thúc toàn chương trình |
| `FOR n` … `NEXT` | `for (int i = 0; i < n; i++) { ... }` | |
| `STL Sn` … `STLE` | `case Sn: { ... break; }` | Mỗi flow là một trạng thái của máy trạng thái |
| `SET Sn` (trong flow) | `step = Sn;` | Chuyển bước, bước cũ tự đóng |
| `ST Sn` | `S[n] = true;` | Mở thêm flow, **giữ** flow hiện tại (chạy song song) |
| Ngắt `Ixxxx` … `IRET` | hàm ngắt (ISR) | Đặt sau `FEND` |

```cpp
// STL: S0 bật Y0, X0 thì sang S1 (bật Y1 trong 5 s rồi về S0)
switch (step) {
  case 0: Y0 = true;  if (X0) step = 1; break;
  case 1: Y1 = true;  if (t0_done) step = 0; break;
}
```

**So sánh, truyền dữ liệu (4.2, 4.3)**

| Lệnh | C++ | Ghi chú |
|---|---|---|
| `LD> D0 K100`, `AND= D1 D2`, `OR<= …` | `D[0] > 100`, `&& D[1] == D[2]`, `\|\| …<=…` | Tiếp điểm so sánh; `<>` là `!=` |
| `CMP S1 S2 D` | `D0 = S1 > S2; D1 = S1 == S2; D2 = S1 < S2;` | Ra 3 bit liên tiếp |
| `ZCP S1 S2 S D` | `D0 = S < S1; D1 = (S >= S1 && S <= S2); D2 = S > S2;` | So với vùng |
| `MOV S D` / `DMOV` | `D = S;` (`int16_t` / `int32_t`) | |
| `BMOV S D n` / `PMOV` | `std::copy_n(&S, n, &D);` | Chép khối n thanh ghi |
| `FMOV S D n` | `std::fill_n(&D, n, S);` | Điền cùng một giá trị |
| `EMOV S D` | `float` gán `f = g;` | Chép số thực |
| `FWRT S D` | ghi Flash/EEPROM | Chậm, giới hạn lần ghi — chỉ gọi bằng sườn |
| `MSET S1 S2` | `for (i = s1; i <= s2; i++) M[i] = true;` | Set vùng bit |
| `ZRST S1 S2` | `for (i = s1; i <= s2; i++) M[i] = false;` | Xoá vùng |
| `SWAP S` | `S = (S << 8) \| (S >> 8);` (`uint16_t`) | Đổi byte cao/thấp |
| `XCH D1 D2` | `std::swap(D1, D2);` | |

**Số học và logic (4.4)**

| Lệnh | C++ | Ghi chú |
|---|---|---|
| `ADD S1 S2 D` / `DADD` | `D = S1 + S2;` | Tràn dải làm tác động cờ SM20/21/22 |
| `SUB S1 S2 D` | `D = S1 - S2;` | |
| `MUL S1 S2 D` | `int32_t D = (int32_t)S1 * S2;` | Kết quả 32-bit chiếm 2 thanh ghi |
| `DIV S1 S2 D` | `if (S2 != 0) { D = S1 / S2; D_next = S1 % S2; }` | Thương, số dư; chia 0 là lỗi |
| `INC D` / `DEC D` | `D++;` / `D--;` | |
| `MEAN S D n` | `D = std::accumulate(&S, &S + n, 0) / n;` | Trung bình |
| `WAND` / `WOR` / `WXOR` | `D = S1 & S2;` / `S1 \| S2` / `S1 ^ S2` | Theo từng bit |
| `CML S D` | `D = ~S;` | Đảo bit |
| `NEG D` | `D = -D;` | Bù 2 |

**Dịch, xoay (4.5) và chuyển đổi (4.6)**

| Lệnh | C++ | Ghi chú |
|---|---|---|
| `SHL D n` / `SHR D n` | `D <<= n;` / `D >>= n;` | Số học (`int16_t`) |
| `LSL D n` / `LSR D n` | `D <<= n;` / `D >>= n;` | Logic (`uint16_t`) |
| `ROL D n` / `ROR D n` | `D = std::rotl(D, n);` / `std::rotr` | `<bit>` C++20 |
| `SFTL` / `SFTR` | dịch mảng bit, ví dụ `std::bitset`, `std::copy` | Chuỗi dài n1, dịch n2 bit |
| `WSFL` / `WSFR` | `std::rotate` / `std::copy_backward` trên mảng word | |
| `WTD S D` | `int32_t d = (int16_t)s;` | Mở rộng 16 → 32 bit |
| `FLT` / `DFLT` / `FLTD` | `float f = (float)s;` (`double` cho 64-bit) | Nguyên → thực |
| `INT S D` | `int d = (int)f;` | Thực → nguyên (cắt phần thập phân) |
| `BCD S D` / `BIN S D` | `((s/10)<<4) \| (s%10)` / `(b>>4)*10 + (b&0xF)` | Ví dụ cho 2 chữ số |
| `ASCI` / `HEX` | `sprintf("%X")` / `strtol(s, 0, 16)` | Hex ↔ ASCII |
| `DECO S D n` | `D = 1u << S;` | n bit → 1 trong 2ⁿ |
| `ENCO` / `ENCOL` | chỉ số bit cao nhất / thấp nhất đang ON (`std::countl_zero`…) | |
| `GRY S D` / `GBIN S D` | `g = b ^ (b >> 1);` / giải mã ngược bằng vòng lặp XOR | Mã Gray |

**Số thực, thời gian thực (4.7, 4.8) và chức năng đặc biệt (mục 5)**

| Lệnh | C++ | Ghi chú |
|---|---|---|
| `ECMP`, `EZCP` | `f1 > f2`, `f >= lo && f <= hi` | So sánh số thực |
| `EADD` `ESUB` `EMUL` `EDIV` | `+` `-` `*` `/` trên `float` | |
| `ESQR` | `std::sqrt(f)` | |
| `SIN` `COS` `TAN` `ASIN` `ACOS` `ATAN` | `std::sin`, `std::cos`, `std::tan`, `std::asin`, `std::acos`, `std::atan` | `<cmath>`, đơn vị radian |
| `TRD D` | `time_t t = time(nullptr); tm* lt = localtime(&t);` | Đọc đồng hồ vào 7 thanh ghi (năm, tháng, ngày, giờ…) |
| `TWR D` | đặt lại đồng hồ hệ thống / RTC | |
| `TCMP` | so sánh `time_t` / từng trường giờ-phút-giây | |
| `CNT HSC0 K…` | bộ đếm phần cứng / ngắt encoder | Đọc bằng `DMOV HSC0 D30` ≈ `int32_t v = hsc0_read();` |
| Xuất xung `Y0`, `Y1`, PWM | `analogWrite` / timer phần cứng | |
| Modbus, `SEND`/`RCV` | thư viện Modbus (`libmodbus`…) hoặc cổng nối tiếp | |
| `PID` | hàm PID: `out = Kp*e + Ki*∫e + Kd*de/dt` | |

Ví dụ trọn một chương trình nhỏ (tính nhiệt độ từ ADC, rồi cảnh báo):

```cpp
// NO:SM0 FLT D0 D10 ; EMUL D10 E0.1 D12 ; EADD D12 E-20.0 D14 ; CMP:LD> …
float f10 = (float)D[0];              // FLT
float f12 = f10 * 0.1f;               // EMUL
float f14 = f12 + (-20.0f);           // EADD
Y0 = (f14 > 60.0f);                   // tiếp điểm so sánh → OUT Y0
```

## 5. Các chức năng đặc biệt (chương riêng trong sổ tay)

| Chức năng | Tóm tắt |
|---|---|
| **Counter tốc độ cao (HSC)** | `CNT HSC0 K…` đếm pha đơn; `CNT_AB` đếm pha A/B (encoder); `RST HSC0` xoá; đọc bằng `DMOV HSC0 D…`, ghi bằng `DMOV K… HSC0`. Dùng ngõ vào X xác định theo bảng gán cổng. Có ngắt HSC 100 đoạn |
| **Xuất xung** | `Y0`, `Y1` (ngõ ra transistor) xuất xung điều khiển servo/step; PWM |
| **Truyền thông** | Modbus RTU (master/slave), truyền thông tự do (RS-232/485); đọc/ghi tham số cổng bằng `CFGCR`/`CFGCW`. XD3 điều khiển biến tần qua Modbus |
| **PID** | Lệnh PID, có chế độ tự điều chỉnh (auto-tune) |
| **Khối hàm C** | Viết hàm bằng ngôn ngữ C |
| **Sequence BLOCK** | Chuỗi lệnh tuần tự theo khối |

Với model 16 I/O, chỉ xung `Y0`, `Y1` và các ngõ vào X đầu tiên phục vụ HSC/ngắt ngoài (`X2`, `X3`…). Gán chính xác cho XD3-16: xem bảng *HSC ports assignment* (mục 5-5) và *Pulse output* của sổ tay.

## 6. Nhập lệnh trong phần mềm XDPPro (icon, phím tắt, menu)

> Nguồn: *XD/XL/XG Series User Manual [Software Section] V3.8.0 (PD03)*, mục 3 và 5 ([bản PDF](https://cdn-en.xinje.com/2026/Updated%20manual/XD%20XL%20XG%20Series%20Programmable%20Controller%20User%20Manual%20(Software%20Section)%20(V3.8.0)%20(PD03%2020250717%201.4.1).pdf)).
> Sổ tay gọi sơ đồ thang (ladder) là *"trapezoidal diagram"*. Biểu tượng nằm trên **thanh nhập thang** (Trapezoid Diagram Input Field) ngay phía trên vùng soạn thảo; tài liệu này mô tả icon theo **tên chức năng + phím tắt** vì không chép hình icon của hãng.

XDPPro lập trình được theo **hai cách**, chuyển qua lại bằng icon *Trapezoidal Chart Conversion* (chuyển thang ⇄ danh sách lệnh) hoặc *Command Language/Ladder* trong menu **View**:
- **Sơ đồ thang (ladder):** trực quan, dành cho phần lớn người lập trình/bảo trì.
- **Danh sách lệnh (instruction list):** dành cho người đã quen lệnh dạng văn bản như ở mục 3–4.

### 6.1 Bố cục cửa sổ

| Vùng | Dùng để |
|---|---|
| Thanh tiêu đề | Tên và đường dẫn dự án đang mở |
| Menu bar | File, Edit, Find/Replace, View… |
| Thanh công cụ chuẩn | Mới, Mở, Lưu, Cắt, Chép, Dán, Tìm, In, Trợ giúp… |
| **Thanh nhập thang** | Icon nhập tiếp điểm, cuộn dây, đường nối (mục 6.3) |
| Thanh cửa sổ | Chuyển giữa biểu đồ, chú thích phần tử mềm, phần tử đã dùng |
| **Bảng thao tác PLC** | Tải xuống, tải lên, Run/Stop, khoá mật khẩu, giám sát |
| Vùng soạn thảo | Vẽ thang, viết chương trình |
| Thanh thông tin | Danh sách lỗi, kết quả biên dịch |
| **Project bar / Command bar** | Cây dự án; danh sách lệnh phân loại theo chức năng |
| Thanh trạng thái | Model PLC, cách kết nối, trạng thái chạy |

### 6.2 Thanh công cụ chuẩn

| Icon (chức năng) | Phím tắt | Ý nghĩa |
|---|---|---|
| Create New Project | Ctrl+N | Tạo dự án mới |
| Open Project | — | Mở dự án đã có |
| Save Project | Ctrl+S | Lưu dự án |
| Cut / Copy / Paste | Ctrl+X / C / V | Cắt / chép / dán thang hoặc câu lệnh |
| Move Backward / Forward Positioning | Alt+Left / Alt+Right | Về / tới vị trí con trỏ trước đó |
| Seek (Find) | Ctrl+F | Tìm phần tử mềm trong phạm vi |
| Ladder Showing Node Annotations | — | Hiện/ẩn chú thích dưới mỗi tiếp điểm |
| Block Display | — | Hiển thị lệnh trục… dạng khối |
| Print | Ctrl+P (cài đặt in) | In chương trình dạng thang hoặc danh sách lệnh |
| Help | F1 | Mở tài liệu trợ giúp |

### 6.3 Thanh nhập thang — icon thêm lệnh thay cho gõ lệnh

**Tiếp điểm (input contact)**

| Icon (tên trong sổ tay) | Lệnh tương ứng | Phím tắt |
|---|---|---|
| Always Open Node (tiếp điểm thường mở) | `LD`/`AND`/`OR` | **F5** |
| Always Closed Node (thường đóng) | `LDI`/`ANI`/`ORI` | **F6** |
| Rising Edge (sườn lên) | `LDP`/`ANDP`/`ORP` | **Shift+F5** |
| Trailing Edge (sườn xuống) | `LDF`/`ANDF`/`ORF` | **Shift+F6** |
| Multi-Condition Rising Edge | sườn lên cho cả nhóm điều kiện | Ctrl+F5 |
| Multi-Condition Descent | sườn xuống cho cả nhóm điều kiện | Ctrl+F6 |
| Take Negation (lấy đảo) | đảo kết quả nhánh | Alt+F6 |

**Cuộn dây (coil)**

| Icon | Lệnh | Phím tắt |
|---|---|---|
| Output Coil, Timing, Counting (cuộn xuất / timer / counter) | `OUT`, `TMR`, `CNT`… | **F7** |
| Set Coil | `SET` | **Shift+F7** |
| Reduction Coil (cuộn reset) | `RST` | **Shift+F8** |
| Other (lệnh khác — mở danh sách lệnh) | MOV, ADD, CALL, FOR… | **F8** |

**Đường nối, nút, hàng**

| Icon | Phím tắt | Chức năng |
|---|---|---|
| Insert Horizontal Line | F11 | Chèn đường ngang |
| Insert Vertical Line | F12 | Chèn đường dọc |
| Delete Line | Shift+F11 | Xoá đường ngang |
| Delete Vertical Line | Shift+F12 | Xoá đường dọc |
| Draw A Line With The Mouse / Delete With Mouse | — | Vẽ / xoá đường nối bằng chuột |
| Insert Node | Ins | Chèn một cột trống bên phải |
| Insert Row | Shift+Ins | Chèn một hàng trống, đẩy thang xuống |
| Delete Node | Del | Xoá nút |
| Delete Row | Shift+Del | Xoá cả hàng |

**Icon cấu hình đặc biệt (cùng thanh nhập)**: *Command Configuration* (cấu hình lệnh), *Configuration Block*, *C Function Block Library* (thư viện hàm C), *Sequential Function Block* (khối tuần tự), *Auto-Adjust Column Width* (tự chỉnh độ rộng cột), *Amplify / Reduce* (phóng to / thu nhỏ), *Trapezoidal Chart Conversion* (chuyển thang ⇄ lệnh), *Grammar* (kiểm tra cú pháp, Ctrl+G).

### 6.4 Cách thêm lệnh bằng icon (thay vì gõ nguyên câu lệnh)

**a) Tiếp điểm.** Bấm vào ô trên thang (khung nét đứt chỉ ô đang chọn) → bấm icon thường mở (hoặc **F5**) → hộp thoại hiện sẵn `LD X0` → sửa toán hạng → **Enter**. Khung nét đứt tự dời sang ô bên phải. Nếu nhập sai, nút chuyển **màu đỏ**; bấm đúp nút để nhập lại.

**b) Cuộn dây.**
Ví dụ `X0 → Y0`: nhập `X0` ở ô đầu, dời khung sang phải một ô → bấm icon cuộn xuất (**F7**) → hộp thoại hiện `OUT` → nhập `Y0` → Enter. Khung tự xuống dòng; nút đỏ nghĩa là sai, bấm đúp để sửa.

**c) Timer, counter.** Chọn icon cuộn xuất (F7), rồi gõ theo mẫu, cách nhau bằng dấu cách:

| Loại | Mẫu nhập |
|---|---|
| Timer thường | `TMR T0 K10 K100` (số timer, giá trị đặt, đơn vị thời gian) |
| Timer tích lũy | `TMR_A HT0 K2000 K10` |
| Counter 16-bit tăng | `CNT C0 K10` |
| Counter 16-bit đếm xuống | `CNT_D C0 K-10` |
| Counter 32-bit tăng | `DCNT C0 K10` |
| Counter 32-bit, giữ khi mất điện (đếm lên) | `DCNT HC0 K10` |

**d) Lệnh khác (MOV, ADD, CALL, FOR…) bằng danh sách lệnh — không cần nhớ tên.**
1. Đặt con trỏ ở ô nhập lệnh.
2. Bấm icon **Other** hoặc **F8**: ngăn **Instruction Classification (Command Bar)** bên trái hiện danh sách lệnh **phân nhóm theo chức năng**, có **ô tìm kiếm** — gõ tên lệnh để lọc.
3. **Bấm đúp** lệnh cần dùng: tên lệnh hiện vào ô đang chọn.
4. Nhập toán hạng (định dạng *lệnh + dấu cách + toán hạng*, ví dụ `MOV K10 D10`) → Enter.
5. Người đã quen có thể **bấm đúp thẳng vào ô** để gõ lệnh và toán hạng trong hộp thoại.

Lưu ý nối dây: mạch phải **liền, không được hở**; nút đỏ là lỗi.

### 6.5 Hình dạng icon trên sơ đồ thang sau khi nhập lệnh

Sau khi bấm Enter, lệnh được vẽ lên thang như dưới đây. Quy ước chung: **thanh cái trái/phải** là hai đường dọc; tiếp điểm nằm bên trái, **cuộn dây và khối lệnh nằm sát thanh cái phải**; tên phần tử ghi phía trên biểu tượng. (Hình vẽ minh họa theo quy ước ladder chuẩn, hiển thị trong bản HTML; trong file Markdown chỉ thấy mã mô tả hình.)

**Các biểu tượng cơ bản**

```ladder
# F5 — tiếp điểm thường mở  (LD X0 / OUT Y0)
NO:X0 OUT:Y0
# F6 — tiếp điểm thường đóng  (LDI X1 / OUT Y1)
NC:X1 NC:X2 OUT:Y1
# Shift+F5 — sườn lên  (LDP X2 / OUT M0)
P:X3 OUT:M0
# Shift+F6 — sườn xuống  (LDF X3 / OUT M1)
N:X4 OUT:M1
# F7 — cuộn xuất OUT
NO:X5 OUT:Y2
# Shift+F7 — SET (cuộn đặt)
NO:X6 SET:Y3
# Shift+F8 — RST (cuộn reset)
NO:X7 RST:Y3
```

| Biểu tượng vẽ | Ý nghĩa | Lệnh danh sách |
|---|---|---|
| hai vạch đứng `⊣ ⊢` | tiếp điểm thường mở | `LD` `AND` `OR` |
| hai vạch đứng có gạch chéo | tiếp điểm thường đóng | `LDI` `ANI` `ORI` |
| hai vạch có mũi tên ↑ / ↓ | sườn lên / sườn xuống | `LDP` / `LDF` … |
| cặp ngoặc `( )` | cuộn xuất | `OUT` |
| ngoặc có chữ **S** / **R** | cuộn đặt / cuộn reset | `SET` / `RST` |
| hình chữ nhật có tên lệnh + toán hạng | lệnh ứng dụng, timer, counter | `MOV`, `TMR`, `CNT`… |

**Tổng kết: ladder Xinje (XDPPro) có bao nhiêu hình vẽ cơ bản?**

Có **7 ký hiệu cơ bản** (4 tiếp điểm + 3 cuộn dây), cộng **1 loại khối chữ nhật** và **các đường nối** để ghép mạch — tổng cộng 3 nhóm:

| Nhóm | Hình | Ký hiệu | Ý nghĩa / khi nào dùng | Phím |
|---|---|---|---|---|
| **A. Tiếp điểm** (điều kiện, nằm bên trái) | 1 | `⊣ ⊢` thường mở (NO) | Dẫn khi phần tử = 1 (`LD/AND/OR`) | F5 |
| | 2 | `⊣/⊢` thường đóng (NC) | Dẫn khi phần tử = 0 (`LDI/ANI/ORI`) | F6 |
| | 3 | `⊣↑⊢` sườn lên | Dẫn đúng 1 chu kỳ quét khi OFF→ON (`LDP/ANDP/ORP`) | Shift+F5 |
| | 4 | `⊣↓⊢` sườn xuống | Dẫn đúng 1 chu kỳ quét khi ON→OFF (`LDF/ANDF/ORF`) | Shift+F6 |
| **B. Cuộn dây** (kết quả, sát thanh cái phải) | 5 | `( )` cuộn xuất | `OUT`: ON khi mạch dẫn, mất dẫn thì OFF | F7 |
| | 6 | `(S)` cuộn đặt | `SET`: lên 1 và **giữ** dù mạch mất dẫn | Shift+F7 |
| | 7 | `(R)` cuộn reset | `RST`: về 0 (cũng xoá timer/counter) | Shift+F8 |
| **C. Khối chữ nhật** | 8 | `[ tên lệnh + toán hạng ]` | Timer `TMR`, counter `CNT`, lệnh ứng dụng `MOV/ADD/CMP…` — cũng đặt cuối hàng | F7 / F8 |
| **D. Đường nối** (không phải linh kiện) | — | đường ngang / dọc | Nối nối tiếp (AND) và rẽ nhánh song song (OR) | F11 / F12 |

Cách đọc: **tiếp điểm nối tiếp = AND, nhánh song song = OR, cuộn dây là kết quả**. Hai phép ghép khối `ORB`/`ANB` không có hình riêng mà do cách vẽ đường dọc/ngang tạo ra. Ngoài ra còn *Take Negation* (đảo kết quả nhánh, Alt+F6) và tiếp điểm sườn nhiều điều kiện (Ctrl+F5/F6) là biến thể của các hình trên, không tính là ký hiệu cơ bản mới.

**So sánh ba phím cuộn dây: F7 / Shift+F7 / Shift+F8**

| Phím | Lệnh | Khi mạch dẫn (điều kiện = 1) | Khi mạch mất dẫn (điều kiện về 0) | Có nhớ trạng thái? |
|---|---|---|---|---|
| **F7** | `OUT` | Phần tử **ON** | Phần tử **OFF** tự động | Không — luôn bám theo mạch |
| **Shift+F7** | `SET` | Phần tử **lên 1 và giữ** | **Vẫn giữ 1**, không tự tắt | Có — chốt đến khi có `RST` |
| **Shift+F8** | `RST` | Phần tử **về 0** (timer/counter: xoá cả giá trị lẫn cuộn ra) | Không làm gì, giữ nguyên trạng thái trước | — |

Ví dụ nút X0 điều khiển Y0 (`SET` đi cặp `RST` bằng X1):

| Thao tác | Dùng `OUT` | Dùng `SET` + `RST` |
|---|---|---|
| Nhấn X0 | Y0 ON | Y0 ON |
| Thả X0 | Y0 **OFF** | Y0 **vẫn ON** |
| Nhấn X1 | không ảnh hưởng | Y0 OFF |

- Dùng `OUT` khi đầu ra chỉ cần bám theo điều kiện (giữ nút thì chạy, thả thì dừng); dùng `SET`/`RST` khi cần nhớ (nhấn Start một lần chạy liên tục, nhấn Stop mới dừng).
- `OUT` cũng nhớ được nếu tự giữ bằng tiếp điểm của chính nó: `( NO:X0 / NO:Y0 ) NC:X1 OUT:Y0`.
- **Không** dùng `OUT` chung phần tử với `SET`/`RST`. Nếu `SET` và `RST` cùng dẫn trong một chu kỳ quét, lệnh nằm **phía dưới** thắng (PLC quét trên xuống) — đặt `RST` dưới `SET` thì Stop luôn ưu tiên.

**Nhánh song song (OR) và tự giữ Start/Stop** — hai tiếp điểm xếp trên/dưới nối vào cùng điểm:

```ladder
# Start/Stop tự giữ  (LD X0 / OR Y0 / ANI X1 / OUT Y0)
( NO:X0 / NO:Y0 ) NC:X1 OUT:Y0
# Hai nhánh nối tiếp song song rồi nối tiếp nhóm OR  (ORB / ANB)
( NO:X0 / NO:X1 ) ( NO:X2 NO:X3 / NC:X4 NO:X5 / NO:X6 ) OUT:Y20
```

**Timer, counter, lệnh ứng dụng** — vẽ thành **khối chữ nhật** ở cuối hàng; tên lệnh và toán hạng ghi trong khối:

```ladder
# Timer 1 giây (10 x 100 ms), sau đó Y0 ON
NO:M0 BOX:TMR_T0_K10_K100
NO:T0 OUT:Y0
# Counter đếm xung X11, reset bằng X10
NO:X10 RST:C0
NO:X11 BOX:CNT_C0_K10
NO:C0 OUT:Y1
# Lệnh ứng dụng: chép hằng vào thanh ghi, cộng, so sánh
NO:X0 BOX:MOV_K10_D10
NO:X1 BOX:ADD_D10_D12_D14
NO:X2 BOX:CMP_D10_D20_M0
```

**Ghi chú về màu và lỗi khi nhập**
- Nút nhập sai hiện **màu đỏ**; bấm đúp để sửa (xem 6.4).
- Mạch phải liền mạch, không để hở giữa tiếp điểm và cuộn.
- `SET`/`RST` vẽ cùng dạng cuộn có chữ S/R; cuộn dây OUT cùng một phần tử xuất hiện hai lần là *dual coil* (xem mục 2).
- Lệnh có cấu hình (PID, xung, HSC, BLOCK, RCV/SEND) cũng vẽ thành khối chữ nhật; bấm đúp khối để mở lại hộp thoại cấu hình.

### 6.6 Lệnh phức tạp: dùng hộp thoại cấu hình thay vì gõ

Các lệnh nhiều tham số được cấu hình bằng panel; đặt con trỏ tại ô nhập lệnh, bấm icon **Command Configuration** (cấu hình lệnh) trên Command bar rồi chọn mục:

| Mục chọn | Dùng cho | Thiết lập chính |
|---|---|---|
| **PID Configuration** | Lệnh PID | Địa chỉ, thông số PID, chế độ, độ vọt lố, chiều tác động |
| **Pulse Configuration** | Xuất xung nhiều đoạn | Loại lệnh, số bit, số đoạn, tần số, thời gian tăng/giảm tốc, địa chỉ |
| **High-Speed Count Configuration** | Counter tốc độ cao (HSC) | Chọn HSC, giá trị so sánh, chế độ tương đối/tuyệt đối, địa chỉ ngắt 100 đoạn |
| **Free-format Communication Configuration** | Lệnh `RCV`/`SEND` | Số hiệu, gửi/nhận, cổng, bộ đệm, kiểm tra lỗi |
| **SMS Configuration / (4G)** | Module G-BOX, 4GBOX | Lệnh SMS |
| **Sequential Function Block (BLOCK)** | Chuỗi xung/đọc-ghi module tuần tự | Thêm lệnh, xung, Wait, đọc/ghi module `FROM`/`TO` |

Sau khi bấm OK, lệnh hiện trên thang. **Sửa tham số:** bấm phải vào lệnh (đổi địa chỉ), các tham số khác sửa qua *Free Monitoring*. Giá trị xung/PID/HSC được **tải xuống PLC cùng chương trình**. Riêng `DRVA`/`DRVI` phải gõ trực tiếp vào thang.

### 6.7 Menu bar — các mục thường dùng

| Menu | Mục | Phím tắt | Chức năng |
|---|---|---|---|
| **File** | Create New / Open / Close / Save / Save as | Ctrl+N / Ctrl+S | Quản lý dự án |
| | Add PLC / Delete PLC / Change PLC Model | — | Thêm, xoá, đổi model PLC trong dự án |
| | Print Settings | Ctrl+P | Cài đặt in |
| **Edit** | Cancel / Redo | Ctrl+Z / Ctrl+Y | Hoàn tác / làm lại (tối đa 10 lần) |
| | Cut / Copy / Paste / Select All / Delete | Ctrl+X/C/V/A, Del | Thao tác khối |
| | Insert/Delete a row, node, vertical line | Shift+Insert, Shift+Delete, Insert | Chèn/xoá hàng, nút, đường dọc |
| | Edit Node Annotation | — | Chú thích nút |
| | **Special Function Instruction Configuration** | — | Mở cấu hình PID, xung, HSC, BLOCK |
| **Find/Replace** | Search / Replace | Ctrl+F / Ctrl+R | Tìm / thay phần tử mềm |
| | Step Number Search / Row Number Search | Ctrl+T | Tìm theo số bước / số dòng |
| | Move backward / forward | Alt+Left / Alt+Right | Điều hướng vị trí |
| **View/Show** | Command Language/Ladder | — | Đổi giữa danh sách lệnh và thang |
| | Ladder Display Node Annotations, Node Annotation Table | — | Hiện chú thích, bảng chú thích phần tử mềm |
| | Amplify / Reduce | — | Phóng to, thu nhỏ thang |

### 6.8 Bảng phím tắt nhanh

| Phím | Chức năng | Phím | Chức năng |
|---|---|---|---|
| F5 | Tiếp điểm thường mở | F7 | Cuộn xuất (OUT/TMR/CNT) |
| F6 | Tiếp điểm thường đóng | Shift+F7 | SET |
| Shift+F5 | Sườn lên | Shift+F8 | RST |
| Shift+F6 | Sườn xuống | F8 | Lệnh khác (bảng danh sách lệnh) |
| Ctrl+F5 / Ctrl+F6 | Sườn lên / xuống nhiều điều kiện | F11 / Shift+F11 | Chèn / xoá đường ngang |
| Alt+F6 | Lấy đảo | F12 / Shift+F12 | Chèn / xoá đường dọc |
| Ins / Del | Chèn / xoá nút | Shift+Ins / Shift+Del | Chèn / xoá hàng |
| Ctrl+G | Kiểm tra cú pháp | F1 | Trợ giúp |

### 6.9 Chú thích, gom nhóm, đưa chương trình xuống PLC

- **Chú thích phần tử mềm:** bấm phải vào phần tử → *Modify Soft Component Annotation*. Bảng đầy đủ: *Soft Component Annotations/Usage* trong Project bar.
- **Chú thích dòng:** bấm phải → *Add Row Comment* (hiện chữ xanh lá). **Chú thích lệnh:** bấm phải → *Modify Instruction Comment*.
- **Gấp/mở khối lệnh:** bấm dấu ngoặc ở lề trái; dùng `GROUP`…`GROUPE` để gom nhóm bất kỳ đoạn nào cho gấp được và hiện trong Project bar.
- **Bảng thao tác PLC:** *Download* (tải chương trình xuống), *Safe Download* (không thể tải ngược lên), *Upload*, *Run*, *Stop*, *Password activation/close* (khoá/mở khoá), *Supervisory Control* (giám sát thang trực tiếp), *Data Monitoring*, *Free Monitoring*, *Oscilloscope Monitoring*, *Communication Parameter Configuration*.
- **Khoá chương trình lần đầu:** nhập mật khẩu trong *PLC Settings → Password* rồi tải lại chương trình; PLC tự khoá. Muốn tải lên phải mở khoá trước.
- **Copy thang giữa các dự án:** không nên chép giữa các phiên bản phần mềm khác nhau; nếu không chép được, chuyển sang danh sách lệnh, dán sang dự án mới rồi chuyển lại sang thang.

## 7. Ví dụ hoàn chỉnh — đèn nhấp nháy, nút Start/Stop, trễ

```
; 1) Start/Stop có tự giữ + đèn báo
LD  X0
OR  Y0
ANI X1
OUT Y0

; 2) Trễ 3 giây rồi bật Y1
LD  Y0
TMR T0 K30 K100
LD  T0
OUT Y1

; 3) Đếm 5 lần nhấn X2 thì bật Y2, X3 reset
LD  X3
RST C0
LD  X2
CNT C0 K5
LD  C0
OUT Y2

; 4) Một nút X4 bật/tắt Y3
LDP X4
ALT M10
LD  M10
OUT Y3

END
```

**Hình ladder tương ứng**

```ladder
# 1) Start/Stop có tự giữ
( NO:X0 / NO:Y0 ) NC:X1 OUT:Y0
# 2) Trễ 3 giây rồi bật Y1
NO:Y0 BOX:TMR_T0_K30_K100
NO:T0 OUT:Y1
# 3) Đếm 5 lần nhấn X2 thì bật Y2, X3 reset
NO:X3 RST:C0
NO:X2 BOX:CNT_C0_K5
NO:C0 OUT:Y2
# 4) Một nút X4 bật/tắt Y3
P:X4 BOX:ALT_M10
NO:M10 OUT:Y3
BOX:END
```

## 8. Lỗi hay gặp / lưu ý

1. Dùng `OUT` cùng một phần tử ở hai nơi → chỉ lần cuối có tác dụng.
2. Quên `RST` cho counter → đếm tiếp không dừng sau khi đạt giá trị đặt.
3. Đơn vị timer: `K100` = 100 ms, `K10` = 10 ms, `K1` = 1 ms — nhầm đơn vị sẽ sai thời gian 10–100 lần.
4. Địa chỉ X/Y là **bát phân** (sau X7 là X10).
5. Lệnh 32-bit (`DMOV`, `DADD`, `DMUL`…) dùng 2 thanh ghi; không dùng địa chỉ chồng nhau.
6. Điều kiện mức liên tục khiến lệnh chạy mỗi chu kỳ quét → dùng `LDP`/`PLS` cho thao tác một lần.
7. Không ghi `FWRT` (Flash) mỗi chu kỳ — Flash có số lần ghi giới hạn.
8. Với `CJ`: phần bị nhảy giữ nguyên trạng thái ngõ ra; timer đã chạy trước khi nhảy vẫn tiếp tục.

## 9. Tài liệu tham khảo

- [XD/XL instruction manual (PD05 v3.5)](https://download.plcsystems.ru/Xinje/docs/XDXL_instruction_manual.pdf) — nguồn chính của tài liệu này (404 trang).
- [XD/XL hardware manual](https://download.plcsystems.ru/Xinje/docs/XDXL_hardware_manual.pdf) — thông số, đấu dây, định nghĩa model.
- [XD/XL/XG Software Section manual V3.8.0 (Xinje, 2025)](https://cdn-en.xinje.com/2026/Updated%20manual/XD%20XL%20XG%20Series%20Programmable%20Controller%20User%20Manual%20(Software%20Section)%20(V3.8.0)%20(PD03%2020250717%201.4.1).pdf) — hướng dẫn phần mềm XDPPro.
- [XD extension module manual](https://cdn-en.xinje.com/XD%20extension%20module%20manual.pdf).
