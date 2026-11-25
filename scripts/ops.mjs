const [action, parameter, option] = process.argv.slice(2);
const base = new URL(process.env.ASSESSMENT_URL || 'http://127.0.0.1:8787');
if (base.username || base.password || (base.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(base.hostname))) {
  throw new Error('Use HTTPS or a loopback development URL.');
}
const token = process.env.ASSESSMENT_OPS_TOKEN;
if (!token) throw new Error('Load ASSESSMENT_OPS_TOKEN from the approved secret store.');
let path, method, body;
if (action === 'invite') {
  method = 'POST';
  path = '/api/ops/invites';
  if (!/^[A-Z]{2}$/.test(parameter || '')) throw new Error('Specify an approved two-letter country.');
  if (option && (!/^\d+$/.test(option) || +option < 5 || +option > 55)) throw new Error('Duration must be 5 to 55 whole minutes.');
  body = {country:parameter,...(option ? {durationMinutes:Number(option)} : {})};
} else if (['get','delete'].includes(action) && /^[0-9a-f]{32}$/.test(parameter || '')) {
  if (action === 'delete' && option !== '--confirm') throw new Error('Supply --confirm to erase this reference.');
  path = '/api/ops/attempts/' + parameter;
  method = action === 'get' ? 'GET' : 'DELETE';
} else {
  throw new Error('Usage: npm run ops -- invite <country> [minutes] | get <reference> | delete <reference> --confirm');
}
const response = await fetch(new URL(path,base), {method, redirect:'error', headers:{'Authorization':'Bearer ' + token,...(body ? {'Content-Type':'application/json'} : {})}, body:body && JSON.stringify(body)});
const raw = await response.text();
let data;
try { data = JSON.parse(raw); }
catch {
  console.error('The operations service did not return JSON. Sign in through Access or check the assessment URL.');
  process.exitCode = 1;
}
if (data && typeof data === 'object') {
  if (!response.ok) { console.error(data.error || 'Request failed.'); process.exitCode = 1; }
  else if (action === 'invite') console.log(JSON.stringify({
    reference: data.reference,
    examMinutes: Number.isInteger(data.durationMinutes) ? data.durationMinutes : null,
    startBy: data.expiresAt ?? null,
    hardEnd: data.hardEnd ?? null,
    expiresAt: data.expiresAt,
    clocks: 'startBy and expiresAt are when an unused link stops opening. That is not the exam clock. examMinutes is the exam length after the candidate starts. hardEnd is the latest moment that exam can reach.',
    url: new URL('/#invite=' + data.invite, base).href,
  }, null, 2));
  else {
    if (action === 'get') console.error('Clocks: inviteExpiresAt is when an unused link stops opening. deadline is when the exam clock ends. purgeAt is when the record is erased. These are different clocks.');
    console.log(JSON.stringify(data, null, 2));
  }
}
