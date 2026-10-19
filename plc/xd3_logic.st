(* ===========================================================================
   Xinje XD3-16T-E  (8 in X0-X7 / 8 out Y0-Y7, transistor)  -  XDPPro, ST
   Offline control logic. Works with no network at all; the gateway only
   reads D0..D39 and writes D3 / D4 over Modbus RTU.

   NOTE: written without access to XDPPro, not compiled. Check syntax and the
   1-second clock relay name against the XD series manual before download.
   Equivalent ladder is trivial; the Modbus map below is what matters.

   Modbus holding-register address == D number (D0 -> address 0).
   --------------------------------------------------------------------------
   D0   X input bitmask (bit n = Xn)                  read
   D1   Y output bitmask (bit n = Yn)                 read
   D2   alarm bits: 1 E-stop, 2 level-sensor fault    read
   D3   mode: 0 auto, 1 manual                        read/write
   D4   manual output mask (bit n -> Yn), manual only read/write
   Conveyor on Y1, product photo-eye on X3 (count on rising edge):
   D6   run request: 0 stop, 1 run                    read/write
   D7   target count, 0 = no limit (stops when reached) read/write
   D8   conveyor state: 0 stopped, 1 running, 2 target reached, 3 E-stop  read
   D9   write 1 = reset current count (PLC clears it)  write
   Hourly history, kept in the PLC (D100-D150, D199-D248 must be latched):
   D100 products counted in the current hour          D101..D148 previous 48 hours, newest first
   D149 seconds elapsed in current hour               D150 hour roll-over counter
   D199 conveyor-run seconds in current hour          D200 run minutes this hour, D201..D248 previous hours
   D14  current count, 32 bit (D14 low)               read
   D16  lifetime count, 32 bit, never reset           read
   D10  uptime seconds, 32 bit (D10 low, D11 high)    read
   D12  pump start count, 32 bit                      read
   D20  runtime seconds of Y0, 32 bit (D20/D21); Yn = D(20+2n)   read
   =========================================================================== *)

(* ---- inputs -> D0 ---- *)
D0 := 0;
IF X0 THEN D0 := D0 OR 16#01; END_IF;   (* X0 E-stop, NC contact: 1 = healthy *)
IF X1 THEN D0 := D0 OR 16#02; END_IF;   (* X1 tank above LOW mark  *)
IF X2 THEN D0 := D0 OR 16#04; END_IF;   (* X2 tank at HIGH mark    *)
IF X3 THEN D0 := D0 OR 16#08; END_IF;   (* X3 conveyor product photo-eye *)
IF X4 THEN D0 := D0 OR 16#10; END_IF;
IF X5 THEN D0 := D0 OR 16#20; END_IF;
IF X6 THEN D0 := D0 OR 16#40; END_IF;
IF X7 THEN D0 := D0 OR 16#80; END_IF;

(* ---- alarms ---- *)
D2 := 0;
IF NOT X0 THEN D2 := D2 OR 1; END_IF;
IF X2 AND NOT X1 THEN D2 := D2 OR 2; END_IF;   (* high but not low = sensor fault *)

(* ---- mode change auto -> manual: keep outputs as they are (bumpless) ---- *)
IF D3 > 1 THEN D3 := 0; END_IF;
IF D3 = 1 AND M1 = FALSE THEN D4 := D1; END_IF;
M1 := (D3 = 1);

(* ---- auto program: Y0 pump fills tank between LOW and HIGH switches ---- *)
IF NOT X1 THEN M0 := TRUE; ELSIF X2 THEN M0 := FALSE; END_IF;

IF D3 = 0 THEN
    D5 := 0;
    IF M0 THEN D5 := 1; END_IF;
ELSE
    D5 := D4 AND 16#7F;     (* Y7 reserved for alarm lamp *)
END_IF;

(* ---- conveyor: Y1 is owned by this block in both modes ---- *)
IF D9 = 1 THEN DD14 := 0; D9 := 0; END_IF;               (* reset current count *)
IF X3 AND NOT M3 THEN DD14 := DD14 + 1; DD16 := DD16 + 1; D100 := D100 + 1; END_IF;
M3 := X3;                                                (* rising-edge memory *)
IF D6 > 1 THEN D6 := 0; END_IF;
M4 := (D7 > 0) AND (DD14 >= D7);                         (* target reached *)
D5 := D5 AND 16#FD;
D8 := 0;
IF D6 = 1 THEN
    IF NOT X0 THEN D8 := 3;
    ELSIF M4 THEN D8 := 2;
    ELSE D8 := 1; D5 := D5 OR 16#02;
    END_IF;
END_IF;

(* ---- interlocks always win ---- *)
IF (D2 AND 2) <> 0 THEN D5 := (D5 AND 16#FE) OR 16#80; M0 := FALSE; END_IF;  (* level fault: pump off, lamp on *)
IF NOT X0 THEN D5 := 16#80; M0 := FALSE; END_IF;        (* E-stop: everything off, lamp on *)
IF NOT X1 THEN D5 := D5 AND 16#FE; END_IF;              (* pump never runs dry *)

(* ---- outputs ---- *)
Y0 := (D5 AND 16#01) <> 0;
Y1 := (D5 AND 16#02) <> 0;
Y2 := (D5 AND 16#04) <> 0;
Y3 := (D5 AND 16#08) <> 0;
Y4 := (D5 AND 16#10) <> 0;
Y5 := (D5 AND 16#20) <> 0;
Y6 := (D5 AND 16#40) <> 0;
Y7 := (D5 AND 16#80) <> 0;
D1 := D5;

(* ---- statistics, once per second (M10 = rising edge of the 1 s clock relay) ---- *)
IF M10 THEN
    DD10 := DD10 + 1;                                  (* uptime *)
    IF Y0 THEN DD20 := DD20 + 1; END_IF;
    IF Y1 THEN DD22 := DD22 + 1; END_IF;
    IF Y2 THEN DD24 := DD24 + 1; END_IF;
    IF Y3 THEN DD26 := DD26 + 1; END_IF;
    IF Y4 THEN DD28 := DD28 + 1; END_IF;
    IF Y5 THEN DD30 := DD30 + 1; END_IF;
    IF Y6 THEN DD32 := DD32 + 1; END_IF;
    IF Y7 THEN DD34 := DD34 + 1; END_IF;
END_IF;
(* ---- hourly history ring (no RTC needed: a free-running 3600 s slot) ---- *)
IF M10 THEN
    D149 := D149 + 1;
    IF D8 = 1 THEN D199 := D199 + 1; END_IF;
    IF D149 >= 3600 THEN
        D200 := D199 / 60;                 (* minutes the conveyor ran this hour *)
        BMOV(D100, D101, 48);              (* shift counts:  D100..D147 -> D101..D148 *)
        BMOV(D200, D201, 48);              (* shift minutes: D200..D247 -> D201..D248 *)
        D100 := 0; D200 := 0; D199 := 0; D149 := 0;
        D150 := D150 + 1;
    END_IF;
END_IF;
(* BMOV is the block-move instruction; check its name/operand order in the XD manual.
   Power-off time is not counted in the hour slot, so hours can be slightly longer than 60 min
   after a restart; the app treats D149 as "seconds into the current slot". *)

IF Y0 AND NOT M2 THEN DD12 := DD12 + 1; END_IF;       (* pump starts *)
M2 := Y0;

(* Keep D3, D6, D7, D10-D35, D100-D150, D199-D248 in the latched (power-off retentive) range in XDPPro:
   PLC settings -> Soft element -> Latched range. *)
