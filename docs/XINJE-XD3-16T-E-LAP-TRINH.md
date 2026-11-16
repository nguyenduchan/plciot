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
| Mở rộng | Mô-đun mở rộng (X/Y 10000…), BD/ED theo cấu hình |

## 1. Phần tử mềm (soft component) của XD3

| Ký hiệu | Ý nghĩa | Dải XD3 | Ghi chú |
|---|---|---|---|
| `X` | Ngõ vào | X0~X7 (16 I/O) | Bát phân |
| `Y` | Ngõ ra | Y0~Y7 (16 I/O) | Bát phân |
| `M` | Rơ-le trung gian (mất khi tắt nguồn) | M0~M69999 | |
| `HM` | Rơ-le trung gian **giữ khi mất điện** | HM0~HM11999 | |
| `SM` | Rơ-le đặc biệt | SM0~SM4999 | Không dùng như M thường |
| `S` / `HS` | Bước/luồng (flow) / giữ điện | S0~S1023 / HS0~HS127 | Dùng với STL |
| `T` | Timer thường | T0~T575 | |
| `HT` | Timer tích lũy, giữ khi mất điện | HT0~HT95 | |
| `ET` | Timer chính xác | ET0~ET31 | |
| `C` | Counter thường | C0~C575 | |
| `HC` | Counter giữ khi mất điện | HC0~HC95 | |
| `HSC` | Counter tốc độ cao | HSC0~HSC31 | |
| `D` | Thanh ghi dữ liệu 16-bit | D0~D7999 | |
| `HD` | Thanh ghi giữ khi mất điện | HD0~HD999 | |
| `SD` / `HSD` | Thanh ghi đặc biệt | SD0~SD2047 / HSD0~HSD499 | |
| `FD` / `SFD` / `FS` | Thanh ghi Flash | FD0~FD5119, SFD0~SFD1999, FS0~FS47 | Ghi bằng `FWRT` |
| `P` | Con trỏ (nhãn nhảy / chương trình con) | P0~P9999 | CJ, CALL |
| `I` | Con trỏ ngắt | Ngắt ngoài X2.. (I0000/I0001…), ngắt timer I40**~I59** | |
| `K` / `H` | Hằng thập phân / thập lục | | `K100`, `H1122` |

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
| `CNT` `CNT_D` `DCNT` `DCNT_D` | Counter 16-bit / 32-bit, đếm lên/xuống; `_D` = giữ khi mất điện |
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
NO:X0 BOX:TMR_A_HT0_K2000_K10
NO:HT0 OUT:Y1
NO:X2 RST:HT0
```


### 3.9 CNT / DCNT — Counter

- `CNT Cn K` — đếm lên 16-bit (giữ giá trị khi mất điện nếu dùng `CNT_D`/HC).
- `DCNT` — đếm 32-bit; `DCNT_D` giữ khi mất điện.
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
# DCNT_D: 32-bit giữ khi mất điện
NO:X12 BOX:DCNT_D_HC0_K100000
```


## 4. Lệnh ứng dụng (applied instructions)

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
| Counter 16-bit giữ điện | `CNT_D HC0 K10` |
| Counter 32-bit tăng | `DCNT C0 K10` |
| Counter 32-bit giữ điện | `DCNT_D HC0 K10` |

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
