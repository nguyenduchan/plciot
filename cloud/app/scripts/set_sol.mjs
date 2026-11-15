const B = 'http://127.0.0.1:3080';
const [id, sol] = process.argv.slice(2);
const t = (await (await fetch(`${B}/api/admin/local-session`)).json()).token;
const r = await fetch(`${B}/api/admin/users/${id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ solution: sol === 'basic' ? '' : sol }) });
console.log(r.status, (await r.text()).slice(0, 120));
