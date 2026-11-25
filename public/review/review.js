const el = id => document.getElementById(id);
let record;
let purgeTimer;
let invitationTimer;
let recordUntil = 0;
let linkUntil = 0;
let clockOffset = 0;
let lastServerTime = 0;
let lastWallTime = Date.now();
function serverTime() {
  // Date.now advances across machine sleep. Clamp normal readings, and fail
  // closed if the system clock moves backward so that it cannot extend access.
  const wallTime = Date.now();
  if (wallTime < lastWallTime) {
    clearReviewerState();
    if (document.visibilityState === 'visible') el('status').textContent = 'The system clock changed. Re-enter the reference to continue.';
    lastServerTime = wallTime + clockOffset;
  } else {
    lastServerTime = Math.max(lastServerTime, wallTime + clockOffset);
  }
  lastWallTime = wallTime;
  return lastServerTime;
}
let pageGeneration = 0;
let operationPending = false;
let selectPrivateLink = false;
const ACCESS_DENIED = 'Staff access is required. Open this page through the organization’s configured reviewer sign-in.';
const CLOSED_RECRUITMENT = 'Scored recruitment is closed. New invitations cannot be created. Existing records can still be retrieved and erased.';

function accessError(message) {
  const error = new Error(message || 'Reviewer sign-in required.');
  error.accessDenied = true;
  return error;
}

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/ops/' + path, {
    method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: method === 'GET' ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw accessError('Sign in through the reviewer Access application.');
  const stamp = Date.parse(response.headers.get('date') || '');
  if (Number.isFinite(stamp)) {
    clockOffset = stamp + 1000 - Date.now();
    serverTime();
  }
  const data = await response.json();
  if (response.status === 401 || response.status === 403) throw accessError(data.error);
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function denyAccess() {
  clearReviewerState();
  el('workspace').hidden = true;
  el('create').hidden = true;
  el('access').textContent = ACCESS_DENIED;
}

async function run(task) {
  if (operationPending) return;
  const generation = pageGeneration;
  const current = () => generation === pageGeneration && document.visibilityState === 'visible';
  operationPending = true;
  const controls = [...el('workspace').querySelectorAll('button,input,select')];
  controls.forEach(control => control.disabled = true);
  el('status').textContent = '';
  try { await task(current); }
  catch (error) {
    if (error?.accessDenied) {
      if (generation === pageGeneration) denyAccess();
      return;
    }
    if (current()) el('status').textContent = error.message || 'Request failed. Please retry.';
  }
  finally {
    if (generation === pageGeneration) {
      controls.forEach(control => control.disabled = false);
      operationPending = false;
      if (selectPrivateLink) {
        selectPrivateLink = false;
        el('invite').focus();
        el('invite').select();
      }
    }
  }
}

function closeConfirm(restoreFocus) {
  const dialog = el('confirm');
  if (dialog.open) dialog.close();
  if (restoreFocus && record && !el('erase').disabled) el('erase').focus();
}

function resetRecord() {
  clearTimeout(purgeTimer);
  recordUntil = 0;
  record = undefined;
  el('record').replaceChildren();
  el('result').hidden = true;
  closeConfirm(false);
}

function clearLookup() {
  resetRecord();
  el('ref').value = '';
}

function clearLink() {
  clearTimeout(invitationTimer);
  linkUntil = 0;
  el('issued').hidden = true;
  el('invite').value = '';
  el('issued-ref').textContent = '';
  el('issued-note').textContent = '';
}
function detail(container, label, value) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value;
  container.append(dt, dd);
}
function closedRecord(data) { return ['submitted','completed','expired'].includes(data.status); }
function formatClock(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : '';
}
function showIntegritySummary(data) {
  if (!closedRecord(data)) return;
  const summary = data.integritySummary;
  if (summary && typeof summary === 'object') {
    const section = document.createElement('section');
    section.className = 'integrity-summary';
    const heading = document.createElement('h4'); heading.textContent = 'Assessment observations'; section.append(heading);
    const list = document.createElement('dl');
    const labels = [
      ['copy','Native copy events'],
      ['contextMenu','Question context menus'],
      ['pageHidden','Assessment page became hidden'],
      ['rejectedAnswer','Answer choices rejected'],
    ];
    for (const [key,label] of labels) {
      const value = summary[key];
      detail(list,label,Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Unavailable');
    }
    section.append(list);
    const note = document.createElement('p');
    note.textContent = 'Counts are distinct questions by category and can overlap. Zero means no signal was reported; it may not be complete. These observations alone cannot establish outside assistance. Browser and accessibility behavior can explain browser observations; a rejected answer can reflect a technical error. If a category needs clarification, ask about the relevant question, calculation steps, tools or any technical issue. These counts do not score the candidate or make a hiring recommendation.';
    section.append(note);
    el('record').append(section);
  } else if (Number.isSafeInteger(data.copiedQuestionCount) && data.copiedQuestionCount >= 0) {
    const context = document.createElement('p');
    context.className = 'copy-shortcut-context';
    context.textContent = data.copiedQuestionCount === 0
      ? 'Copy-shortcut signal: 0 distinct questions reported. A zero is not proof that none occurred. This alone cannot establish outside assistance.'
      : `Copy-shortcut signal: ${data.copiedQuestionCount} distinct question${data.copiedQuestionCount === 1 ? '' : 's'} reported. This alone cannot establish outside assistance.`;
    el('record').append(context);
  } else {
    const context = document.createElement('p');
    context.className = 'integrity-unavailable';
    context.textContent = !data.notice
      ? 'Integrity observations are unavailable for this assessment.'
      : data.notice.integrityReview === true || data.notice.copyShortcutReview === true
        ? 'Integrity observations are unavailable for this assessment.'
        : 'Integrity observations were not enabled for this assessment.';
    el('record').append(context);
  }
}
function responseCorrect(response) {
  if (!Array.isArray(response.selected) || !Array.isArray(response.expected)) return null;
  const selected = [...response.selected].sort(), expected = [...response.expected].sort();
  return selected.length === expected.length && selected.every((value,index) => value === expected[index]);
}
function tableLearningPrompt(data) {
  const tables = [data.referenceTable, ...(data.responses || []).map(response => response.table)].filter(Boolean);
  let revenue = null, costs = null;
  for (const table of tables) {
    if (!Array.isArray(table.headers) || table.headers.length !== 2 || !Array.isArray(table.rows) || table.rows.length !== 5) continue;
    const findValue = pattern => {
      const row = table.rows.find(values => pattern.test(String(values?.[0] || '')));
      if (!row || row.length !== 2 || typeof row[1] !== 'string') return null;
      return row[1].trim();
    };
    const candidateRevenue = findValue(/^revenue(?:\s*\(.*\))?$/i), candidateCosts = findValue(/^direct\s+costs?(?:\s*\(.*\))?$/i);
    if (candidateRevenue && candidateCosts) { revenue = candidateRevenue; costs = candidateCosts; break; }
  }
  if (!revenue || !costs) return null;
  const euro = value => /€|eur/i.test(value) ? value : '€' + value;
  return `Using this candidate’s ${euro(revenue)} revenue and ${euro(costs)} direct costs, walk me through gross margin in euros and as a percentage. Ask which calculation they used and whether any technical issue affected their work.`;
}
function applyRecruitmentMode(config) {
  const countries = new Intl.DisplayNames(['en'],{type:'region'});
  el('country').replaceChildren();
  for (const country of config.countries || []) {
    const option = document.createElement('option');
    option.value = country; option.textContent = countries.of(country) || country;
    el('country').append(option);
  }
  el('minutes').placeholder = String(config.durationMinutes || 30);
  const ttl = Number.isInteger(config.inviteTtlMinutes) ? config.inviteTtlMinutes : null;
  el('minutes-help').textContent = ttl
    ? `Exam length, counted from the moment the candidate starts. The private link has a separate start-by window of up to ${ttl} minutes, and that window shrinks when a longer exam would pass the one-hour limit. The start-by time is not the exam clock.`
    : 'Exam length, counted from the moment the candidate starts. The private link has a separate start-by time. That time is not the exam clock.';
  const open = config.enabled === true;
  el('create').hidden = !open;
  el('lede').textContent = open
    ? 'Create a private invitation or retrieve one assessment using its reference.'
    : 'Retrieve one assessment using its reference. New invitations stay off while scored recruitment is closed.';
  el('access').textContent = open ? 'Signed in through staff access.' : CLOSED_RECRUITMENT;
}

el('issue').addEventListener('submit', event => {
  event.preventDefault();
  run(async current => {
    const minutes = el('minutes').value;
    const data = await api('invites','POST',{country:el('country').value,...(minutes ? {durationMinutes:Number(minutes)} : {})});
    if (!current()) return;
    if (data.expiresAt && serverTime() >= data.expiresAt) {
      clearLink();
      throw new Error('The invitation expired before it could be displayed. Create a new invitation.');
    }
    clearTimeout(invitationTimer);
    linkUntil = data.expiresAt || 0;
    if (linkUntil) invitationTimer = setTimeout(clearLink,Math.max(0,linkUntil - serverTime()));
    const examMinutes = Number.isInteger(data.durationMinutes) ? data.durationMinutes : Number(minutes);
    const startBy = formatClock(data.expiresAt);
    el('issued-ref').textContent = data.reference;
    el('invite').value = new URL('/#invite=' + data.invite, location.origin).href;
    el('issued-note').textContent = startBy
      ? `Exam length is ${examMinutes} minutes from the moment the candidate starts. The candidate must open this link before ${startBy}. That start-by time is not the exam clock.`
      : `Exam length is ${examMinutes} minutes from the moment the candidate starts. The link's start-by time is not the exam clock.`;
    el('issued').hidden = false;
    el('status').textContent = 'Invitation created. This link is shown once. The start-by time is not the exam clock.';
  });
});
el('hide-link').onclick = clearLink;
el('copy').onclick = () => run(async () => {
  try {
    await navigator.clipboard.writeText(el('invite').value);
    el('status').textContent = 'Private link copied.';
  } catch {
    selectPrivateLink = true;
    throw new Error('Clipboard is unavailable. Select the private link and copy it.');
  }
});
el('ref').addEventListener('input', () => {
  const lowered = el('ref').value.toLowerCase();
  if (lowered !== el('ref').value) {
    const at = el('ref').selectionStart;
    el('ref').value = lowered;
    if (at !== null) el('ref').setSelectionRange(at, at);
  }
  resetRecord();
});
el('lookup').addEventListener('submit', event => {
  event.preventDefault();
  run(async current => {
    resetRecord();
    const referenceValue = el('ref').value.trim().toLowerCase();
    el('ref').value = referenceValue;
    const data = await api('attempts/' + referenceValue);
    if (!current()) return;
    if (data.purgeAt && serverTime() >= data.purgeAt) {
      clearLookup();
      throw new Error('This assessment record has expired and is no longer available.');
    }
    record = data;
    recordUntil = data.purgeAt;
    purgeTimer = setTimeout(clearLookup,Math.max(0,recordUntil - serverTime()));
    const info = document.createElement('dl');
    const closed = closedRecord(data);
    detail(info,'Reference',data.reference);
    detail(info,'Status',data.status);
    if (Number.isInteger(data.durationMinutes)) detail(info,'Exam length',data.durationMinutes + ' minutes from the start. This is the exam clock.');
    if (data.status === 'invited') detail(info,'Exam clock','Not started. It starts when the candidate starts, and only if that is before the start-by time.');
    const examEnds = formatClock(data.deadline);
    if (examEnds) detail(info,'Exam clock ends',examEnds + ' — answering stops. This is not the invitation start-by time.');
    const startBy = formatClock(data.inviteExpiresAt);
    if (startBy) detail(info,'Invitation start-by',startBy + ' — an unused link stops opening. This is not the exam clock.');
    const erasure = formatClock(data.purgeAt);
    if (erasure) detail(info,'Scheduled erasure',erasure + ' — the record is deleted. This is not the exam clock.');
    if (closed && Number.isInteger(data.score)) detail(info,'Score',data.score + ' / ' + data.total);
    else if (!closed) detail(info,'Score','Hidden until the attempt is submitted or the exam clock ends.');
    else detail(info,'Score','No submitted score on this closed record.');
    if (!closed) detail(info,'Answer key','Hidden until the attempt is submitted or the exam clock ends.');
    else if (Number.isInteger(data.answered) && Number.isInteger(data.total)) detail(info,'Progress',data.answered + ' of ' + data.total + ' saved');
    el('record').append(info);
    showIntegritySummary(data);
    const responses = closed && Array.isArray(data.responses) ? data.responses : [];
    const filtersSupported = closed && responses.length > 0 && responses.every(response => responseCorrect(response) !== null);
    let filter = 'all';
    let filterNav;
    if (filtersSupported) {
      filterNav = document.createElement('nav'); filterNav.className = 'response-filters'; filterNav.setAttribute('aria-label','Filter responses');
      const rows = [ ['all','All'], ['correct','Correct'], ['incorrect','Incorrect'], ['unanswered','Unanswered'] ];
      for (const [key,label] of rows) {
        const button = document.createElement('button'); button.type='button'; button.dataset.filter=key; button.textContent=label;
        button.setAttribute('aria-pressed',String(key==='all'));
        button.addEventListener('click',() => { filter=key; renderResponses(); });
        filterNav.append(button);
      }
      el('record').append(filterNav);
    }
    const responseHost = document.createElement('div'); responseHost.className='response-list'; el('record').append(responseHost);
    function renderResponses() {
      responseHost.replaceChildren();
      if (filterNav) for (const button of filterNav.querySelectorAll('button')) button.setAttribute('aria-pressed',String(button.dataset.filter===filter));
      const filtered = responses.filter(response => {
        if (filter==='all') return true;
        if (filter==='unanswered') return response.selected.length===0;
        if (response.selected.length===0) return false;
        return responseCorrect(response) === (filter==='correct');
      });
      if (!filtered.length) { const empty=document.createElement('p'); empty.textContent='No responses in this category.'; responseHost.append(empty); return; }
      for (const response of filtered) {
      const item = document.createElement('details'), heading = document.createElement('summary'), answers = document.createElement('dl');
      heading.textContent = response.question;
      detail(answers,'Selected',(response.selected || []).join(', ') || 'Unanswered');
      detail(answers,'Expected',(response.expected || []).join(', '));
      if (filtersSupported && response.selected.length) detail(answers,'Result',responseCorrect(response) ? 'Correct' : 'Incorrect');
      item.append(heading);
      if (response.table) {
        const scroller = document.createElement('div');
        scroller.className = 'table-scroll';
        const table = document.createElement('table');
        const caption = table.createCaption();
        caption.textContent = 'Reference figures';
        const head = table.createTHead().insertRow();
        for (const label of response.table.headers) {
          const cell = document.createElement('th');
          cell.scope = 'col'; cell.textContent = label; head.append(cell);
        }
        const body = table.createTBody();
        for (const figures of response.table.rows) {
          const row = body.insertRow();
          figures.forEach((value,index) => {
            const cell = document.createElement(index === 0 ? 'th' : 'td');
            if (index === 0) cell.scope = 'row';
            cell.textContent = value; row.append(cell);
          });
        }
        scroller.append(table);
        item.append(scroller);
      }
      item.append(answers); responseHost.append(item);
      }
    }
    renderResponses();
    if (closed) {
      const prompt = tableLearningPrompt(data);
      if (prompt) {
        const guide = document.createElement('aside'); guide.className='learning-prompt';
        const heading=document.createElement('h4'); heading.textContent='Optional learning conversation';
        const text=document.createElement('p'); text.textContent=prompt;
        guide.append(heading,text); el('record').append(guide);
      }
    }
    el('result').hidden = false;
    el('status').textContent = 'Record retrieved.';
  });
});
el('erase').onclick = () => {
  const dialog = el('confirm');
  if (!dialog.open) dialog.showModal();
  el('cancel').focus();
};
el('cancel').onclick = () => closeConfirm(true);
el('confirm').addEventListener('cancel', event => {
  event.preventDefault();
  closeConfirm(true);
});
el('erase-confirm').onclick = () => run(async () => {
  if (!record || record.reference !== el('ref').value.trim().toLowerCase()) return;
  await api('attempts/' + record.reference,'DELETE',{});
  resetRecord(); el('ref').value = ''; el('status').textContent = 'Assessment record erased.';
});
document.addEventListener('visibilitychange',() => {
  if (document.visibilityState === 'hidden') {
    clearReviewerState();
  } else {
    if (recordUntil && serverTime() >= recordUntil) clearLookup();
    if (linkUntil && serverTime() >= linkUntil) clearLink();
  }
});
window.addEventListener('pagehide', clearReviewerState);
function clearReviewerState() {
  pageGeneration++;
  operationPending = false;
  for (const control of el('workspace').querySelectorAll('button,input,select')) control.disabled = false;
  clearLink();
  clearLookup();
  closeConfirm(false);
}
try {
  const data = await api('whoami');
  if (data.authorized !== true) throw accessError('Staff access is required.');
  let config;
  try {
    const configResponse = await fetch('/api/config',{cache:'no-store'});
    if (!configResponse.ok || !configResponse.headers.get('content-type')?.includes('application/json')) throw new Error('settings');
    config = await configResponse.json();
    if (!config || typeof config !== 'object') throw new Error('settings');
  } catch {
    el('create').hidden = true;
    el('workspace').hidden = false;
    el('lede').textContent = 'Retrieve one assessment using its reference.';
    el('access').textContent = 'Staff access is confirmed, but recruitment settings could not be loaded. New invitations stay off. Existing records can still be retrieved and erased.';
    config = null;
  }
  if (config) {
    el('workspace').hidden = false;
    applyRecruitmentMode(config);
  }
} catch (error) {
  el('workspace').hidden = true;
  el('create').hidden = true;
  el('access').textContent = error?.accessDenied ? ACCESS_DENIED : (error?.message || 'The reviewer workspace could not be opened. Please retry.');
}
