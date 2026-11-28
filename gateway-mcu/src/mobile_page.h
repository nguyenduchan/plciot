#pragma once
// Trang cài đặt bằng điện thoại (mobile.cpp, GET /m) — một file HTML tự chứa, không tải gì từ Internet.
static const char kMobilePage[] = R"HTML(<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Cài đặt gateway</title>
<style>
:root{--bg:#0f1419;--card:#1a222b;--line:#2a3541;--tx:#e6edf3;--mu:#8b98a5;--ac:#14b8a6;--ok:#22c55e;--bad:#ef4444;--warn:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:90px}
header{position:sticky;top:0;z-index:5;background:#0b0f14;border-bottom:1px solid var(--line);padding:10px 16px}
header b{font-size:17px}.sub{color:var(--mu);font-size:13px}
.tabs{display:flex;gap:8px;margin-top:8px}.tabs button{flex:1}
main{padding:12px 16px;max-width:640px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
h3{margin:0 0 10px;font-size:16px}label{display:block;color:var(--mu);font-size:13px;margin:10px 0 4px}
select,input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0b0f14;color:var(--tx);font-size:16px}
input.err{border-color:var(--bad)}.errtx{color:var(--bad);font-size:13px;margin-top:4px}
button{padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#24303c;color:var(--tx);font-size:15px;cursor:pointer}
button.pri{background:var(--ac);border-color:var(--ac);color:#04201d;font-weight:600}button.big{width:100%;padding:16px;font-size:17px}
button.sel{background:var(--ac);color:#04201d;border-color:var(--ac)}button.dan{color:#fca5a5}button:disabled{opacity:.5}
.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}
.stepper{display:flex;gap:8px}.stepper button{width:64px;font-size:24px;flex:none}.stepper input{text-align:center;font-size:22px}
.dev .t{font-weight:600}.dev .m{color:var(--mu);font-size:13px}.vals{margin:8px 0;font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--mu);margin-right:6px}.dot.on{background:var(--ok)}.dot.bad{background:var(--bad)}
.probe{margin-top:8px;padding:8px 10px;border-radius:8px;background:#0b0f14;font-size:15px}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.acts button{flex:1;min-width:84px;padding:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ch{background:#0b0f14;border:1px solid var(--line);border-radius:10px;padding:10px}
.ch .n{font-size:13px;color:var(--mu)}.ch .nm{font-weight:600;min-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sheet{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:20}.sheet.open{display:block}
.sheet .in{position:absolute;left:0;right:0;bottom:0;max-height:88vh;overflow:auto;background:var(--card);border-radius:18px 18px 0 0;padding:16px 16px 28px;max-width:640px;margin:auto}
.tpl{padding:12px;border:1px solid var(--line);border-radius:10px;margin:6px 0}.tpl.sel{border-color:var(--ac);background:#0f2a28}
.tpl small{color:var(--mu)}.chk{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}.chk input{width:22px;height:22px;flex:none}
.toast{position:fixed;left:16px;right:16px;bottom:16px;padding:14px;border-radius:12px;background:#24303c;z-index:30;display:none;max-width:608px;margin:auto}
.toast.bad{background:#4c1d1d}.toast.ok{background:#14382c}.muted{color:var(--mu);font-size:13px}
.foot{position:fixed;left:0;right:0;bottom:0;background:#0b0f14;border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:8px}
.foot button{flex:1}
</style></head><body>
<header><b>Cài đặt gateway</b> <span id="hdr" class="sub"></span>
<div class="tabs" id="tabs" style="display:none"><button id="tb-rs" class="sel" onclick="tab('rs')">RS485</button><button id="tb-io" onclick="tab('io')">DI / DO</button><button id="tb-ac" onclick="tab('ac')">Tài khoản</button></div></header>
<main id="main"></main>
<div class="foot" id="foot" style="display:none"><button onclick="finish()">✓ Hoàn tất lắp đặt</button><button onclick="logout()">Đăng xuất</button></div>
<div class="sheet" id="sheet" onclick="if(event.target===this)closeSheet()"><div class="in" id="sheetIn"></div></div>
<div class="toast" id="toast"></div>
<script>
let REV=-1,TOKEN=sessionStorage.getItem('mtok')||'',S=null,CAT=null,TAB='rs',PR={},SH=null,timer=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>typeof v!=='number'?'—':Math.abs(v)>=1000||Number.isInteger(v)?String(Math.round(v*100)/100):v.toFixed(Math.abs(v)<10?2:1);
function toast(m,k){const t=$('toast');t.textContent=m;t.className='toast '+(k||'');t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',k==='bad'?6000:3000)}
async function api(m,p,b){
  const r=await fetch(p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:b?JSON.stringify(b):undefined}).catch(()=>null);
  if(!r)return{Ok:false,Msg:'Mất kết nối tới board — điện thoại còn chung mạng với board?'};
  let j={};try{j=await r.json()}catch(e){}
  if(r.status===401&&p!=='/api/m/login'){TOKEN='';sessionStorage.removeItem('mtok');login();}
  if(j.Ok===undefined)j.Ok=r.ok;
  if(j.Err==='rev_conflict'){closeSheet();await refresh();REV=S?S.Rev:REV;render();}
  return j;
}
function login(msg){
  clearInterval(timer);$('tabs').style.display='none';$('foot').style.display='none';$('hdr').textContent='';
  $('main').innerHTML=`<div class="card"><h3>Đăng nhập kỹ thuật viên</h3>
  <p class="muted">1. Nhấn nút <b>BOOT</b> trên board (còi kêu "bíp").<br>2. Nhập tên của bạn rồi bấm Đăng nhập trong vòng 10 phút.<br>Chủ trạm sẽ nhận thông báo ai đã cài đặt.</p>
  <label>Tên kỹ thuật viên</label><input id="nm" autocomplete="name" value="${esc(localStorage.getItem('mname')||'')}">
  <div id="lerr" class="errtx">${esc(msg||'')}</div><p><button class="pri big" onclick="doLogin()">Đăng nhập</button></p></div>`;
}
async function doLogin(){
  const n=$('nm').value.trim();localStorage.setItem('mname',n);
  const j=await api('POST','/api/m/login',{Name:n});
  if(!j.Ok){$('lerr').textContent=j.Msg||j.Err||'Lỗi';return}
  TOKEN=j.Token;sessionStorage.setItem('mtok',TOKEN);start();
}
async function mut(m,p,b){const j=await api(m,p,Object.assign({Rev:S?S.Rev:undefined},b));if(j.Ok){await refresh();REV=S.Rev;}return j}
async function start(){api('POST','/api/m/catalog',{}).then(j=>{if(j.Ok&&!CAT){CAT=j.Templates||[];if(!SH)render()}});$('tabs').style.display='flex';$('foot').style.display='flex';await refresh();render();clearInterval(timer);timer=setInterval(async()=>{if(SH)return;await refresh();
  if(S&&S.Rev!==REV){const lc=S.LastChange;if(REV>=0&&lc&&lc.Rev===S.Rev&&lc.By!==S.Who)toast(`${lc.By} vừa sửa: ${lc.What}`,'ok');REV=S.Rev;render()}else renderLive()},2000)}
async function refresh(){const j=await api('GET','/api/m/state');if(j.Ok)S=j;
  if(S)$('hdr').textContent=`· ${S.Who||''} · Cloud: ${({Connected:'đã nối',Connecting:'đang nối',Disconnected:'mất nối',Disabled:'chưa cài'})[S.Cloud]||S.Cloud}`+(S.Gateway?' · chế độ gateway PC':'')+(S.Techs&&S.Techs.length>1?' · cùng cài: '+S.Techs.join(', '):'')+(S.SafeMode?' · ⚠ an toàn':'')}
function tab(t){TAB=t;for(const k of['rs','io','ac'])$('tb-'+k).className=t===k?'sel':'';render()}
function render(){if(!S)return;$('main').innerHTML=TAB==='rs'?rsHtml():TAB==='io'?ioHtml():acHtml()}
function renderLive(){if(!S)return;
  if(TAB==='ac'){if(!AC)$('main').innerHTML=acHtml();return}
  if(TAB==='io'){$('main').innerHTML=ioHtml();return}
  for(const d of S.Devices.filter(d=>d.Kind==='rs485')){const e=$('v-'+d.Child);if(e)e.innerHTML=valsHtml(d)}}
const devs=k=>S.Devices.filter(d=>d.Kind===k);
function valsHtml(d){const r=d.Fields.filter(f=>f.Access!=='Write').map(f=>`${esc(f.Label)}: <b>${fmt(f.Value)}</b> ${esc(f.Unit)}`);return r.join(' · ')||'<span class="muted">—</span>'}
function rsHtml(){
  const p=S.Port,polls=[500,1000,2000,5000,10000];
  let h=`<div class="card"><h3>Cổng RS485 (chung cho mọi thiết bị trên dây)</h3>
  <div class="row"><div><label>Tốc độ baud</label><select id="pb">${[1200,2400,4800,9600,19200,38400,57600,115200].map(b=>`<option ${b===p.Baud?'selected':''}>${b}</option>`).join('')}</select></div>
  <div><label>Khung truyền</label><select id="pp">${[['None','8-N-1'],['Even','8-E-1'],['Odd','8-O-1']].map(([v,n])=>`<option value="${v}" ${v===p.Parity?'selected':''}>${n}</option>`).join('')}</select></div></div>
  <label>Chu kỳ đọc dữ liệu: <b id="pl">${p.PollMs/1000} giây</b></label><input id="pr" type="range" min="0" max="4" step="1" value="${Math.max(0,polls.indexOf(polls.reduce((a,b)=>Math.abs(b-p.PollMs)<Math.abs(a-p.PollMs)?b:a)))}" oninput="$('pl').textContent=[0.5,1,2,5,10][this.value]+' giây'" style="padding:0">
  <p><button class="pri" style="width:100%" onclick="savePort()">Lưu cổng RS485</button></p>${p.Set?'':'<p class="muted">Chưa lưu — mặc định 9600, 8-N-1, 2 giây.</p>'}</div>`;
  const ds=devs('rs485');
  h+=ds.length?'':'<p class="muted">Chưa có thiết bị RS485. Bấm nút bên dưới để thêm.</p>';
  for(const d of ds){const pr=PR[d.Child];
    h+=`<div class="card dev"><div class="t">${esc(d.Title)}${d.Paused?' <span class="muted">(tạm dừng)</span>':''}</div><div class="m">${esc(tplName(d.Model))} · Slave ID ${d.Unit}</div>
    <div class="vals" id="v-${esc(d.Child)}">${valsHtml(d)}</div>
    ${pr?`<div class="probe"><span class="dot ${pr.Ok?'on':'bad'}"></span>${pr.Ok?pr.Items.filter(x=>x.Value!==undefined).map(x=>`${fmt(x.Value)} ${esc(x.Unit)}`).join(' | '):esc(pr.Msg||'Không đọc được')}</div>`:''}
    <div class="acts"><button class="pri" onclick="probe('${d.Child}')">Đọc thử</button>${d.Fields.some(f=>f.Access!=='Read')?`<button onclick="writeSheet('${d.Child}')">Ghi thử</button>`:''}
    ${d.Model?`<button onclick="devSheet('${d.Child}')">Sửa</button>`:''}<button class="dan" onclick="removeDev('${d.Child}')">Xoá</button></div></div>`}
  const other=S.Devices.filter(d=>d.Kind==='tcp'||d.Kind==='other');
  if(other.length)h+=`<p class="muted">Thiết bị khác (cài bằng GatewayApp): ${other.map(d=>esc(d.Title)).join(', ')}</p>`;
  return h+`<button class="pri big" onclick="devSheet()">＋ Thêm thiết bị RS485</button>`;
}
const tplName=id=>(CAT&&CAT.find(t=>t.id===id)||{}).name||id||'';
async function savePort(){const j=await mut('PUT','/api/m/port',{Baud:+$('pb').value,Parity:$('pp').value,PollMs:[500,1000,2000,5000,10000][$('pr').value]});toast(j.Ok?(j.Msg||'Đã lưu'):(j.Msg||j.Err),j.Ok?'ok':'bad');await refresh();render()}
async function probe(c){PR[c]={Ok:true,Items:[],Msg:''};const e=document.querySelector(`#v-${c}`);toast('Đang đọc thử…');
  const j=await api('POST','/api/m/probe',{Child:c});PR[c]=j;render();toast(j.Ok?'Đọc được — đấu dây đúng':'Không đọc được: '+(j.Msg||''),j.Ok?'ok':'bad')}
async function removeDev(c){const d=S.Devices.find(x=>x.Child===c);if(!confirm(`Xoá "${d.Title}"? Thông số của thiết bị này sẽ không còn hiện trên app.`))return;
  const j=await mut('POST','/api/m/remove',{Child:c});toast(j.Msg||j.Err,j.Ok?'ok':'bad');render()}
function openSheet(h){SH=1;$('sheetIn').innerHTML=h;$('sheet').className='sheet open'}
function closeSheet(){SH=null;$('sheet').className='sheet'}
async function loadCat(){toast('Đang tải danh sách thiết bị mẫu…');const j=await api('POST','/api/m/catalog',{});if(j.Ok){CAT=j.Templates||[];if(j.Msg)toast(j.Msg,'bad');else $('toast').style.display='none'}else toast(j.Msg||'Lỗi','bad');return CAT||[]}
let F={};
async function devSheet(child){
  const d=child?S.Devices.find(x=>x.Child===child):null;
  F={child:child||'',tpl:d?d.Model:'',unit:d?d.Unit:nextFree(),title:d?d.Title:'',show:d?d.Fields.map(f=>f.Field):null,q:''};
  openSheet('<p class="muted">Đang tải…</p>');await loadCat();sheetDev();
}
function nextFree(ex){const u=new Set(devs('rs485').filter(d=>d.Child!==F.child).map(d=>d.Unit));for(let i=1;i<=247;i++)if(!u.has(i)&&i!==ex)return i;return 1}
function sheetDev(){
  const t=CAT.find(x=>x.id===F.tpl),q=F.q.toLowerCase();
  const list=CAT.filter(x=>!q||(x.name+' '+x.brand+' '+x.model).toLowerCase().includes(q));
  const used=devs('rs485').find(d=>d.Unit===F.unit&&d.Child!==F.child);
  let h=`<h3>${F.child?'Sửa thiết bị':'Thêm thiết bị RS485'}</h3>
  <label>1. Loại thiết bị</label>${t&&!F.pick?`<div class="tpl sel" onclick="F.pick=1;sheetDev()"><b>${esc(t.name)}</b><br><small>${esc(t.brand)} ${esc(t.model)} · mặc định ${t.serial.baud} 8-${t.serial.parity[0]}-1 · bấm để đổi</small></div>`:
   `<input placeholder="Tìm: biến tần, đồng hồ điện, INVT…" value="${esc(F.q)}" oninput="F.q=this.value;sheetDev();const i=document.querySelector('#sheetIn input');i.focus();i.setSelectionRange(99,99)">
   ${list.map(x=>`<div class="tpl ${x.id===F.tpl?'sel':''}" onclick="pickTpl('${x.id}')"><b>${esc(x.name)}</b><br><small>${esc(x.brand)} ${esc(x.model)}${x.note?' · '+esc(x.note):''}</small></div>`).join('')||'<p class="muted">Không có mẫu phù hợp. Nhờ kỹ sư thêm mẫu trên GatewayAdmin rồi mở lại.</p>'}`}
  <label>2. Địa chỉ trạm (Slave ID)</label>
  <div class="stepper"><button onclick="F.unit=Math.max(1,F.unit-1);sheetDev()">−</button><input id="un" type="number" inputmode="numeric" min="1" max="247" value="${F.unit}" class="${used?'err':''}" onchange="F.unit=Math.min(247,Math.max(1,+this.value||1));sheetDev()"><button onclick="F.unit=Math.min(247,F.unit+1);sheetDev()">+</button></div>
  ${used?`<div class="errtx">Địa chỉ ID ${F.unit} đã dùng cho "${esc(used.Title)}", vui lòng chọn số khác (gợi ý: ID ${nextFree(F.unit)}).</div>`:''}
  <label>3. Tên gọi hiển thị trên app</label><input id="ti" placeholder="${esc(t?t.name:'Ví dụ: Quạt hút xưởng 1')}" value="${esc(F.title)}" oninput="F.title=this.value">`;
  if(t){const show=F.show||t.fields.filter(f=>f.show!==false).map(f=>f.key);F.show=show;
    h+=`<label>Thông số hiện trên app chủ xưởng</label>${t.fields.map(f=>`<label class="chk"><input type="checkbox" ${show.includes(f.key)?'checked':''} onchange="tgl('${f.key}',this.checked)"><span>${esc(f.label)}${f.unit?' ('+esc(f.unit)+')':''}${f.access==='w'?' <small class="muted">· lệnh</small>':f.access==='rw'?' <small class="muted">· đọc/ghi</small>':''}</span></label>`).join('')}
    <div id="pp2"></div>`}
  h+=`<div class="acts" style="margin-top:16px"><button onclick="closeSheet()">Huỷ</button>${t?`<button onclick="probeTpl()">Đọc thử</button>`:''}<button class="pri" ${!t||used?'disabled':''} onclick="saveDev()">Lưu</button></div>`;
  $('sheetIn').innerHTML=h;
}
function pickTpl(id){F.tpl=id;F.pick=0;F.show=null;sheetDev()}
function tgl(k,on){F.show=F.show.filter(x=>x!==k);if(on)F.show.push(k)}
async function probeTpl(){$('pp2').innerHTML='<div class="probe">Đang đọc thử…</div>';
  const j=await api('POST','/api/m/probe',{Template:F.tpl,Unit:F.unit});
  $('pp2').innerHTML=`<div class="probe"><span class="dot ${j.Ok?'on':'bad'}"></span>${j.Ok?j.Items.map(x=>x.Value!==undefined?`${esc(x.Label)}: <b>${fmt(x.Value)}</b> ${esc(x.Unit)}`:`${esc(x.Label)}: ${esc(x.Err)}`).join('<br>'):esc(j.Msg||j.Err||'Không đọc được')}</div>`}
async function saveDev(){const j=await mut('POST','/api/m/device',{Template:F.tpl,Unit:F.unit,Title:F.title.trim(),Show:F.show,Child:F.child||undefined});
  if(!j.Ok){if(j.Suggest){F.unit=j.Suggest}toast(j.Msg||j.Err,'bad');return}
  closeSheet();toast(j.Msg||'Đã lưu — bấm "Đọc thử" để kiểm tra đấu dây',j.Msg?'':'ok');await refresh();render();if(j.Child)probe(j.Child)}
function writeSheet(c){const d=S.Devices.find(x=>x.Child===c);
  openSheet(`<h3>Ghi thử — ${esc(d.Title)}</h3><p class="muted">Lệnh ghi thật xuống thiết bị. Kiểm tra an toàn trước khi chạy máy.</p>`+
  d.Fields.filter(f=>f.Access!=='Read').map(f=>`<label>${esc(f.Label)}${f.Unit?' ('+esc(f.Unit)+')':''}${f.Min!==undefined?` · ${f.Min}…${f.Max}`:''}</label>
  <div class="row">${f.Kind==='toggle'?`<button class="pri" onclick="wr('${c}','${f.Field}',1)">${esc(f.On||'Bật')}</button><button onclick="wr('${c}','${f.Field}',0)">${esc(f.Off||'Tắt')}</button>`:
  `<input id="w-${f.Field}" type="number" inputmode="decimal" step="any" value="${f.Value??''}"><button class="pri" style="flex:none" onclick="wr('${c}','${f.Field}',+$('w-${f.Field}').value)">Ghi</button>`}</div>`).join('')+
  `<p><button style="width:100%" onclick="closeSheet()">Đóng</button></p>`)}
async function wr(c,f,v){const j=await api('POST','/api/m/write',{Child:c,Field:f,Value:v});toast(j.Ok?'Đã ghi '+v:(j.Msg||j.Err),j.Ok?'ok':'bad')}
// ---------------- DI / DO
const ICONS=[['bulb','Đèn'],['pump','Bơm'],['valve','Van'],['fan','Quạt'],['motor','Động cơ'],['alarm','Còi'],['door','Cửa'],['do','Khác']];
function chOwner(kind,ch){return S.Devices.find(d=>d.Kind==='dio'&&d.Ch===(kind==='do'?ch:-ch))}
function ioHtml(){
  let h=`<div class="card"><h3>Đầu ra DO (relay / transistor)</h3><p class="muted">Bấm Bật/Tắt để thử đấu dây, rồi "Đặt tên" để hiện trên app.</p><div class="grid">`;
  for(let i=1;i<=8;i++){const d=chOwner('do',i),on=S.Do[i-1];
    h+=`<div class="ch"><div class="n"><span class="dot ${on?'on':''}"></span>DO${i}</div><div class="nm">${d?esc(d.Title):'<span class="muted">chưa dùng</span>'}</div>
    <div class="acts"><button onclick="doT(${i},1)">Bật</button><button onclick="doT(${i},0)">Tắt</button></div><div class="acts"><button onclick="dioSheet('do',${i})">${d?'Sửa':'Đặt tên'}</button>${d?`<button class="dan" onclick="rmDio('${d.Child}')">✕</button>`:''}</div></div>`}
  h+=`</div>${S.DoOk?'':'<p class="errtx">⚠ Không điều khiển được DO (chip TCA9554 không trả lời)</p>'}</div><div class="card"><h3>Đầu vào DI</h3><p class="muted">Chấm xanh = có tín hiệu (cập nhật mỗi 2 giây).</p><div class="grid">`;
  for(let i=1;i<=8;i++){const d=chOwner('di',i),on=S.Di[i-1];
    h+=`<div class="ch"><div class="n"><span class="dot ${on?'on':''}"></span>DI${i} · ${on?'CÓ':'không'}</div><div class="nm">${d?esc(d.Title):'<span class="muted">chưa dùng</span>'}</div>
    <div class="acts"><button onclick="dioSheet('di',${i})">${d?'Sửa':'Đặt tên'}</button>${d?`<button class="dan" onclick="rmDio('${d.Child}')">✕</button>`:''}</div></div>`}
  return h+'</div></div>';
}
async function doT(ch,on){const j=await api('POST','/api/m/do',{Ch:ch,On:!!on});if(!j.Ok)toast(j.Msg||j.Err,'bad');await refresh();render()}
async function rmDio(c){const d=S.Devices.find(x=>x.Child===c);if(!confirm(`Bỏ "${d.Title}" khỏi app?`))return;const j=await mut('POST','/api/m/remove',{Child:c});toast(j.Msg||j.Err,j.Ok?'ok':'bad');render()}
function dioSheet(kind,ch){const d=chOwner(kind,ch);let fb=0;
  if(d&&kind==='do'){const f=d.Fields.find(x=>x.Field==='fb');if(f){const m=/DI(\d)/.exec(f.Label);fb=m?+m[1]:0}}
  F={kind,ch,child:d?d.Child:'',icon:d?d.Icon:(kind==='do'?'bulb':'di')};
  openSheet(`<h3>${kind.toUpperCase()}${ch}</h3>${kind==='do'?`<label>Loại</label><div class="acts">${ICONS.map(([k,n])=>`<button id="ic-${k}" class="${F.icon===k?'sel':''}" onclick="F.icon='${k}';document.querySelectorAll('[id^=ic-]').forEach(b=>b.className=b.id==='ic-${k}'?'sel':'')">${n}</button>`).join('')}</div>`:''}
  <label>Tên hiện trên app</label><input id="dn" value="${esc(d?d.Title:'')}" placeholder="${kind==='do'?'Ví dụ: Đèn kho':'Ví dụ: Cửa tủ mở'}">
  ${kind==='do'?`<label>Tín hiệu phản hồi (DI nối tiếp điểm phụ / cảm biến chạy)</label><select id="fb"><option value="0">Không có</option>${[1,2,3,4,5,6,7,8].map(i=>`<option value="${i}" ${i===fb?'selected':''}>DI${i}</option>`).join('')}</select>`:''}
  <div class="acts" style="margin-top:16px"><button onclick="closeSheet()">Huỷ</button><button class="pri" onclick="saveDio()">Lưu</button></div>`)}
async function saveDio(){const b={Kind:F.kind,Ch:F.ch,Title:$('dn').value.trim(),Icon:F.icon,Fb:F.kind==='do'?+$('fb').value:0,Child:F.child||undefined};
  const j=await mut('POST','/api/m/dio',b);if(!j.Ok){toast(j.Msg||j.Err,'bad');return}closeSheet();toast('Đã lưu','ok');await refresh();render()}
// ---------------- gắn tài khoản chủ trạm (mã 8 số, chủ trạm duyệt trên webapp — điện thoại không nhập mật khẩu)
let AC=null,acT=null;
function acHtml(){const a=S.Account||{};
  if(AC)return`<div class="card"><h3>Mã gắn tài khoản</h3><div style="font-size:40px;letter-spacing:6px;text-align:center;font-weight:700;margin:12px 0">${esc(AC.UserCode)}</div>
   <p class="muted">Chủ trạm mở webapp (đăng nhập như bình thường) → duyệt mã này. Có thể mở ngay trên điện thoại này nếu chủ trạm ở cạnh, hoặc gửi link cho chủ trạm.</p>
   <div class="acts"><a href="${esc(AC.VerifyUrl)}" target="_blank" style="flex:1"><button class="pri" style="width:100%">Mở webapp để duyệt</button></a>${navigator.share?`<button onclick="navigator.share({title:'Duyệt gateway',text:'Mã gắn gateway: ${esc(AC.UserCode)}',url:'${esc(AC.VerifyUrl)}'})">Gửi cho chủ trạm</button>`:''}</div>
   <p id="acst" class="muted">⏳ Đang chờ chủ trạm duyệt…</p><button onclick="acStop()">Huỷ</button></div>`;
  return`<div class="card"><h3>Tài khoản chủ trạm</h3>${a.Registered?`<p><span class="dot on"></span>Đã gắn tài khoản · <b>${esc(a.Site)}/${esc(a.Device)}</b> · Cloud: ${esc(S.Cloud)}</p>
   <p class="muted">Gắn sang tài khoản khác: chủ cũ phải đồng ý trên webapp.</p><button onclick="acStart()">Gắn sang tài khoản khác</button>`:
   `<p class="muted">Board chưa gắn tài khoản nào nên chưa lên app. Bấm lấy mã → chủ trạm duyệt trên webapp → thiết bị đã cài hiện trên app của chủ trạm.</p>
   <button class="pri big" onclick="acStart()">Lấy mã gắn tài khoản</button>`}</div>`}
async function acStart(){const j=await api('POST','/api/m/account/start',{});if(!j.Ok){toast(j.Msg||j.Err,'bad');return}
  AC=j;render();clearInterval(acT);acT=setInterval(acPoll,3000)}
function acStop(){clearInterval(acT);AC=null;render()}
async function acPoll(){const j=await api('POST','/api/m/account/poll',{});
  if(j.Ok&&j.Status==='pending')return;
  clearInterval(acT);AC=null;await refresh();render();toast(j.Ok?(j.Msg||'Đã gắn tài khoản '+j.User):(j.Msg||j.Err),j.Ok?'ok':'bad')}
async function finish(){if(S&&S.Account&&!S.Account.Registered&&!confirm('Board CHƯA gắn tài khoản chủ trạm (chưa lên app). Vẫn hoàn tất?'))return;
  if(!confirm('Hoàn tất lắp đặt?\n\nTrang cài đặt bằng điện thoại sẽ TẮT HẲN (kể cả khi nhấn BOOT). Muốn mở lại phải dùng PC quản trị hoặc nhờ hỗ trợ từ xa.'))return;
  const j=await api('POST','/api/m/finish',{});if(j.Ok){TOKEN='';sessionStorage.removeItem('mtok');clearInterval(timer);$('tabs').style.display='none';$('foot').style.display='none';$('main').innerHTML=`<div class="card"><h3>✓ Đã hoàn tất</h3><p>${esc(j.Msg)}</p></div>`}else toast(j.Msg||j.Err,'bad')}
async function logout(){await api('POST','/api/m/logout',{});TOKEN='';sessionStorage.removeItem('mtok');login()}
if(TOKEN)start();else login();
</script></body></html>)HTML";
