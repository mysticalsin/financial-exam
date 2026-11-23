import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';

const refs = {
  A: 'a'.repeat(32), B: 'b'.repeat(32), C: 'c'.repeat(32), D: 'd'.repeat(32), E: 'e'.repeat(32), F: 'f'.repeat(32),
};
const invitations = Object.fromEntries(Object.entries(refs).map(([name, reference]) => [
  reference,
  { name, reference, invite: reference + '.' + name.toLowerCase().repeat(64), status: 'invited', attempt: null },
]));
const calls = [];
const integrityCalls = [];
const startPayloads = [];
let delayAnswer = false;
let loseStartResponseFor = 'E';
const liveActive = item => item.status === 'active' && item.attempt && Date.now() < item.attempt.purgeAt;
const root = new URL('../public/', import.meta.url);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const ref = request.headers['x-assessment-reference'];
  const cookie = /__Host-assessment=([0-9a-f]{32})\.([a-f0-9]{64})/.exec(request.headers.cookie || '')?.[1];
  const body = async () => {
    let text = '';
    for await (const chunk of request) text += chunk;
    return text ? JSON.parse(text) : {};
  };
  const json = (status, data, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(data));
  };
  if (url.pathname.startsWith('/api/')) {
    calls.push({method: request.method, path: url.pathname, reference: ref || null, cookie});
    if (url.pathname === '/api/config') return json(200, {enabled:true, durationMinutes:15, countries:['FR']});
    if (url.pathname === '/api/invitation' && request.method === 'POST') {
      const {invite} = await body();
      const invited = Object.values(invitations).find(item => item.invite === invite);
      if (!invited) return json(403, {error:'Invitation unavailable'});
      if (invited.attempt?.purgeAt <= Date.now()) invited.status = 'expired';
      const anotherActiveSession = Boolean(cookie && cookie !== invited.reference && liveActive(invitations[cookie]));
      if (invited.status !== 'invited') {
        if (cookie !== invited.reference) return json(403, {error:'Invitation unavailable'});
        return json(200, {reference:invited.reference, resume:true, attempt:invited.attempt,
          serverNow:Date.now(), notice:invited.attempt.notice});
      }
      return json(200, {reference:invited.reference, resume:false, anotherActiveSession,
        country:'FR', durationMinutes:15, expiresAt:Date.now()+60000, hardEnd:Date.now()+3600000,
        serverNow:Date.now(), notice:invited.notice});
    }
    if (url.pathname === '/api/start' && request.method === 'POST') {
      const startData = await body();
      startPayloads.push(startData);
      const {invite} = startData;
      const invited = Object.values(invitations).find(item => item.invite === invite);
      if (!invited) return json(403, {error:'Invitation unavailable'});
      if (invited.notice.integrityReview === true && (startData.integrityReview !== true || Object.hasOwn(startData,'copyShortcutReview')))
        return json(409,{error:'Please review the integrity notice before starting.'});
      if (invited.notice.integrityReview !== true && invited.notice.copyShortcutReview === true && startData.copyShortcutReview !== true)
        return json(409,{error:'Please review the copy-shortcut notice before starting.'});
      if (invited.notice.integrityReview !== true && invited.notice.copyShortcutReview !== true && Object.hasOwn(startData,'copyShortcutReview'))
        return json(400,{error:'Unexpected copy-shortcut acknowledgement.'});
      if (cookie && cookie !== invited.reference && liveActive(invitations[cookie]))
        return json(409, {error:'Another assessment is active'});
      const now = Date.now();
      invited.status = 'active';
      invited.attempt = {
        reference: invited.reference, status:'active', revision:1, country:'FR',
        startedAt:now, deadline:now+60000,
        purgeAt: now + (invited.name === 'C' || invited.name === 'D' ? 4500 : 60000),
        submittedAt:null, total:2, answered:0, answers:{}, notice:invited.notice,
        questions:[
          {id:'q1', section:'Financial foundations', prompt:`Candidate ${invited.name} private prompt 841`, multiple:false,
            options:[{id:'x1',text:'€275'},{id:'x2',text:'€325'}]},
          {id:'q2', section:'Applied reading', prompt:`Candidate ${invited.name} private prompt 842`, multiple:false,
            options:[{id:'y1',text:'€40'},{id:'y2',text:'€50'}]},
        ],
      };
      if (invited.name === loseStartResponseFor) {
        loseStartResponseFor = null;
        return json(503,{error:'Synthetic lost start response'});
      }
      return json(200, {attempt:invited.attempt, serverNow:now}, {
        'Set-Cookie':`__Host-assessment=${invited.reference}.${invited.name.toLowerCase().repeat(64)}; Path=/; Secure; HttpOnly; SameSite=Strict`,
      });
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      if (!ref || ref !== cookie) return json(409, {error:'Invitation changed'});
      const current = invitations[ref];
      if (!current?.attempt || Date.now() >= current.attempt.purgeAt) return json(200, {attempt:null, serverNow:Date.now()});
      return json(200, {attempt:current.attempt, serverNow:Date.now()});
    }
    if (url.pathname === '/api/integrity' && request.method === 'PUT') {
      const data=await body();
      integrityCalls.push({data,cookie:cookie||null,reference:ref||null});
      const current=invitations[cookie];
      const modern=current?.attempt?.notice.integrityReview === true;
      assert.deepEqual(Object.keys(data).sort(),modern?['kind','questionId','reference']:['questionId','reference']);
      if (!cookie || cookie !== data.reference || ref !== data.reference) return json(409,{error:'Invitation changed'});
      if (!current?.attempt || current.attempt.status !== 'active' || !(current.attempt.notice.copyShortcutReview === true || current.attempt.notice.integrityReview === true))
        return json(409,{error:'Assessment closed'});
      if (modern) {
        assert.ok(['copy','contextMenu','pageHidden'].includes(data.kind));
        current.attempt.integrityCalls ||= [];
        if (!current.attempt.integrityCalls.some(item=>item.kind===data.kind&&item.questionId===data.questionId)) current.attempt.integrityCalls.push(data);
      } else {
        current.attempt.copyShortcutQuestionIds ||= [];
        if (!current.attempt.copyShortcutQuestionIds.includes(data.questionId)) current.attempt.copyShortcutQuestionIds.push(data.questionId);
      }
      return json(200,{recorded:true});
    }
    if (url.pathname === '/api/answers' && request.method === 'PUT') {
      const data = await body();
      if (!cookie || cookie !== data.reference || ref !== data.reference) return json(409,{error:'Invitation changed'});
      if (delayAnswer) await new Promise(resolve => setTimeout(resolve, 6500));
      const current = invitations[cookie];
      if (!current?.attempt || current.attempt.status !== 'active') return json(409,{error:'Assessment closed'});
      current.attempt.answers[data.questionId] = data.choices;
      current.attempt.answered = Object.keys(current.attempt.answers).length;
      current.attempt.revision++;
      return json(200, {attempt:current.attempt, serverNow:Date.now()});
    }
    if (url.pathname === '/api/submit' && request.method === 'POST') {
      const data = await body();
      if (!cookie || cookie !== data.reference || ref !== data.reference) return json(409,{error:'Invitation changed'});
      const current = invitations[cookie];
      if (!current?.attempt || !current.attempt.answered) return json(409,{error:'Answer required'});
      current.attempt.status = 'submitted';
      current.status = 'submitted';
      current.attempt.submittedAt = Date.now();
      current.attempt.purgeAt = Date.now()+60000;
      return json(200, {attempt:current.attempt, serverNow:Date.now()}, {
        'Set-Cookie':`__Host-assessment=${cookie}.${current.name.toLowerCase().repeat(64)}; Path=/; Secure; HttpOnly; SameSite=Strict`,
      });
    }
    return json(404,{error:'Unexpected API route'});
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[a-z0-9.-]+$/i.test(file)) { response.writeHead(404); return response.end(); }
  try {
    const bytes = await readFile(new URL(file, root));
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html';
    response.writeHead(200, {'Content-Type':type,'Cache-Control':'no-store'});
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});

const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHROMIUM_CHANNEL} : {})});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const notice = {controller:'Synthetic controller', contact:'privacy@example.invalid', purpose:'Synthetic test', basis:'Synthetic basis', recipients:'Synthetic recipients', transfers:'Synthetic transfers', rights:'Synthetic rights', supervisoryAuthority:'Synthetic authority', version:'synthetic-v1', retentionMinutes:30};
for (const invitation of Object.values(invitations)) invitation.notice = {...notice,...(['A','E'].includes(invitation.name)?{copyShortcutReview:true}:invitation.name==='F'?{integrityReview:true}:{})};
const link = name => `${origin}/#invite=${invitations[refs[name]].invite}`;
const selectText = async (page, selector) => page.locator(selector).evaluate(node => {
  const range=document.createRange();
  range.selectNodeContents(node);
  const selection=window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
});
const noApplicantContent = async page => {
  const body = await page.locator('body').innerText();
  for (const name of Object.keys(refs)) {
    assert.equal(body.includes(`Candidate ${name} private prompt 841`), false, `no ${name} first prompt disclosure`);
    assert.equal(body.includes(`Candidate ${name} private prompt 842`), false, `no ${name} second prompt disclosure`);
  }
  for (const reference of Object.values(refs)) assert.equal(body.includes(reference), false, 'no candidate reference disclosure');
};

try {
  const context = await browser.newContext();
  const a = await context.newPage();
  await a.goto(link('A'));
  a.on('pageerror', error => console.error('Candidate page error:', error.message));
  assert.equal(await a.evaluate(() => location.hash), '', 'the invitation fragment is removed after capture');
  assert.equal((await a.evaluate(() => location.href)).includes(invitations[refs.A].invite), false,
    'the invitation secret does not remain in the address');
  const invitedWelcome=await a.locator('#practice-intro').innerText();
  assert.match(invitedWelcome,/Recruitment invitation/i);
  assert.match(invitedWelcome,/country privacy notice applies/);
  assert.doesNotMatch(invitedWelcome,/^Anonymous practice$|No name or sign-in required|does not save a practice record|answers stay in this tab until submission/im,
    'an inspected recruitment invitation does not show anonymous-practice claims');
  await a.getByRole('button',{name:/Review your invitation/}).click();
  const preflightText=await a.locator('#workspace').innerText();
  assert.match(preflightText,/Ctrl\/Cmd\+C/);
  assert.match(preflightText,/selected text inside an active question/);
  assert.match(preflightText,/human review/);
  assert.match(preflightText,/cannot establish outside assistance/);
  await a.getByRole('checkbox').check();
  await a.getByRole('button',{name:'Start assessment'}).click();
  try { await a.getByText('Candidate A private prompt 841').waitFor(); }
  catch (error) { console.error('Candidate A state:', await a.locator('body').innerText(), calls); throw error; }
  assert.equal(await a.locator('#active-question').evaluate(node=>getComputedStyle(node).animationName),'card-rise','the active question settles in once');
  assert.equal(startPayloads[0].copyShortcutReview,true,'start confirms the enabled setting shown in preflight');
  assert.equal(await a.locator('#active-question details.copy-shortcut-notice').getAttribute('open'),null,
    'the detailed active-question notice stays available but collapsed');
  assert.match(await a.locator('#active-question details.copy-shortcut-notice').evaluate(node=>node.textContent),/clipboard contents are not collected/);
  await a.evaluate(()=>document.addEventListener('keydown',event=>{
    if(event.key.toLowerCase()==='c'&&(event.ctrlKey||event.metaKey)) window.__copyDefaultPrevented=event.defaultPrevented;
  }));
  await selectText(a,'#answered-count');
  await a.keyboard.press('Control+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,0,'copying text outside the active question is not reported');
  await a.locator('#active-question').evaluate(card=>{
    const input=document.createElement('input'); input.id='synthetic-editable-target'; input.type='text'; card.append(input); input.focus();
  });
  await selectText(a,'#question-title');
  await a.keyboard.press('Control+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,0,'copy shortcuts directed at editable input targets are ignored');
  await a.locator('#synthetic-editable-target').evaluate(input=>input.remove());
  await a.keyboard.press('x');
  assert.equal(integrityCalls.length,0,'ordinary typing does not create an integrity signal');
  await a.keyboard.press('Control+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,1,'a trusted copy shortcut over selected active-question text is reported');
  assert.deepEqual(integrityCalls[0].data,{reference:refs.A,questionId:'q1'},'only assessment reference and question id are sent');
  assert.equal(integrityCalls[0].reference,refs.A);
  assert.equal(integrityCalls[0].cookie,refs.A);
  assert.equal(await a.evaluate(()=>window.__copyDefaultPrevented),false,'the browser copy shortcut is not prevented');
  await a.keyboard.press('Control+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,1,'repeated shortcuts are deduplicated per question');
  await a.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true})));
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,1,'synthetic untrusted keyboard events are ignored');
  const boundHistory = await a.evaluate(() => history.state);
  assert.equal(boundHistory.reference, refs.A);

  const bare = await context.newPage();
  const callsBeforeBare = calls.length;
  await bare.goto(origin+'/');
  await bare.getByRole('button',{name:/Start practice assessment/}).waitFor();
  assert.match(await bare.locator('#landing-title').innerText(),/Financial\s+Test/);
  assert.match(await bare.locator('#practice-intro').innerText(),/ANONYMOUS PRACTICE/i);
  assert.match(await bare.locator('#practice-intro').innerText(),/No name or sign-in required/);
  await noApplicantContent(bare);
  assert.equal(calls.slice(callsBeforeBare).some(call => call.path === '/api/session'), false,
    'a fresh homepage tab does not ask the shared cookie who it belongs to');
  assert.equal(calls.slice(callsBeforeBare).some(call => call.path.startsWith('/api/practice/')), false,
    'opening the welcome page alone does not issue a practice challenge');

  const b = await context.newPage();
  await b.goto(link('B'));
  await b.getByRole('status').getByText(/private browsing window|separate browser/i).waitFor();
  await noApplicantContent(b);
  await a.getByLabel('€275').check();
  try { await a.getByText('Answer saved.').waitFor(); }
  catch (error) { console.error('Candidate A save state:', await a.locator('body').innerText(), calls.slice(-5)); throw error; }
  assert.ok(calls.some(call => call.path === '/api/answers' && call.reference === refs.A && call.cookie === refs.A),
    'a saved answer names the tab invitation and matches the host cookie');
  await a.locator('#next').click();
  await a.getByText('Candidate A private prompt 842').waitFor();
  await selectText(a,'#question-title');
  await a.keyboard.press('Meta+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,2,'a distinct active question can report one signal');
  assert.deepEqual(integrityCalls[1].data,{reference:refs.A,questionId:'q2'});
  await a.keyboard.press('Meta+C');
  await a.waitForTimeout(100);
  assert.equal(integrityCalls.length,2,'the second question is also deduplicated');
  await a.getByLabel('€40').check();
  await a.getByText('Answer saved.').waitFor();
  await a.locator('#review-nav').click();
  await a.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true})));
  await a.waitForTimeout(50);
  assert.equal(integrityCalls.length,2,'review view no longer has the active-question listener');
  await a.getByRole('button',{name:'Submit assessment'}).click();
  await a.getByRole('button',{name:'Confirm submission'}).click();
  await a.getByText('Assessment submitted').waitFor();
  assert.equal((await a.locator('body').innerText()).includes(refs.A), true);
  assert.ok(calls.some(call => call.path === '/api/submit' && call.reference === refs.A && call.cookie === refs.A),
    'submission names the tab invitation and matches the host cookie');

  await b.goto(link('B'));
  try { await b.getByRole('button',{name:/Review your invitation/}).waitFor({timeout:5000}); }
  catch (error) { console.error('Candidate B preflight state:', await b.locator('body').innerText(), calls.slice(-8)); throw error; }
  assert.doesNotMatch(await b.locator('#practice-intro').innerText(),/^Anonymous practice$|No name or sign-in required|does not save a practice record|answers stay in this tab until submission/im);
  await b.getByRole('button',{name:/Review your invitation/}).click();
  assert.equal(await b.locator('.copy-shortcut-notice').count(),0,'a country notice without the feature has no copy-shortcut disclosure');
  await b.getByRole('checkbox').check();
  await b.getByRole('button',{name:'Start assessment'}).click();
  await b.getByText('Candidate B private prompt 841').waitFor();
  assert.equal(Object.hasOwn(startPayloads[1],'copyShortcutReview'),false,'disabled countries omit the start acknowledgement');
  assert.equal(await b.locator('.copy-shortcut-notice').count(),0,'disabled countries do not show an active-question notice');
  await selectText(b,'#question-title');
  await b.keyboard.press('Meta+C');
  await b.waitForTimeout(100);
  assert.equal(integrityCalls.length,2,'disabled countries do not collect copy signals');
  await a.getByText(/connected to a different invitation/i).waitFor();
  await noApplicantContent(a);
  await selectText(a,'#landing-title');
  await a.keyboard.press('Control+C');
  await a.waitForTimeout(50);
  assert.equal(integrityCalls.length,2,'a stale tab cannot send a signal after its assessment view is cleared');
  await a.evaluate(state => history.replaceState(state, '', '/'), {...boundHistory, until:Date.now()+60000});
  const callsBeforeRestore = calls.length;
  await a.reload();
  await a.getByRole('status').getByText(/invitation changed|different invitation|could not be opened/i).waitFor();
  await noApplicantContent(a);
  assert.equal(calls.slice(callsBeforeRestore).some(call => call.path === '/api/session' && call.reference === refs.A), true,
    'a stale bound tab requests only its reference and gets rejected when the shared cookie belongs to B');

  const retryContext=await browser.newContext();
  const retry=await retryContext.newPage();
  await retry.goto(link('E'));
  await retry.getByRole('button',{name:/Review your invitation/}).click();
  await retry.getByRole('checkbox').check();
  await retry.getByRole('button',{name:'Start assessment'}).click();
  await retry.getByText('Synthetic lost start response').waitFor();
  const lostStartCalls=startPayloads.filter(data=>data.invite===invitations[refs.E].invite);
  assert.equal(lostStartCalls.length,1);
  assert.equal(lostStartCalls[0].copyShortcutReview,true,'first start records the displayed acknowledgement');
  const savedAcknowledgement=await retry.evaluate(()=>Object.values(sessionStorage).map(value=>JSON.parse(value)).find(value=>value?.version==='synthetic-v1'));
  assert.equal(savedAcknowledgement?.copyShortcutReview,true,'the acknowledgement is kept with the same short-lived retry claim');
  assert.equal(JSON.stringify(await retry.evaluate(()=>Object.values(sessionStorage))).includes(invitations[refs.E].invite),false,
    'the original invitation URL is not stored to support the retry');
  await retry.goto(link('E'));
  await retry.getByText('Candidate E private prompt 841').waitFor({timeout:5000});
  const recoveredStartCalls=startPayloads.filter(data=>data.invite===invitations[refs.E].invite);
  assert.equal(recoveredStartCalls.length,2,'reload retries a start whose response was lost');
  assert.equal(recoveredStartCalls[1].copyShortcutReview,true,'recovery preserves the originally acknowledged setting');
  assert.equal(recoveredStartCalls[1].claim,recoveredStartCalls[0].claim,'retry remains bound to the same claim');
  assert.equal(recoveredStartCalls[1].noticeVersion,recoveredStartCalls[0].noticeVersion,'retry remains bound to the same notice version');
  await retryContext.close();

  const modernContext=await browser.newContext();
  const modern=await modernContext.newPage();
  await modern.goto(link('F'));
  await modern.getByRole('button',{name:/Review your invitation/}).click();
  const modernPreflight=await modern.locator('#workspace').innerText();
  assert.match(modernPreflight,/native copy event/i);
  assert.match(modernPreflight,/context menu/i);
  assert.match(modernPreflight,/page became hidden/i);
  assert.match(modernPreflight,/answer choices that were not assigned/i);
  assert.match(modernPreflight,/can overlap/i);
  assert.match(modernPreflight,/I have read how this assessment works and how these observations are reviewed/i);
  await modern.getByRole('checkbox').check();
  await modern.getByRole('button',{name:'Start assessment'}).click();
  await modern.getByText('Candidate F private prompt 841').waitFor();
  const modernStart=startPayloads.find(data=>data.invite===invitations[refs.F].invite);
  assert.equal(modernStart.integrityReview,true);
  assert.equal(Object.hasOwn(modernStart,'copyShortcutReview'),false,'new notice sends only its matching acknowledgement');
  assert.match(await modern.locator('#integrity-local-status').innerText(),/may be incomplete/);
  await modern.bringToFront();
  await selectText(modern,'#question-title');
  await modern.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');
  await modern.waitForFunction(()=>document.querySelector('#integrity-local-status')?.textContent.includes('copy 1'),null,{timeout:5000});
  assert.deepEqual(integrityCalls.at(-1).data,{reference:refs.F,questionId:'q1',kind:'copy'});
  assert.deepEqual(Object.keys(integrityCalls.at(-1).data).sort(),['kind','questionId','reference']);
  await modern.locator('#question-title').click({button:'right'});
  await modern.waitForFunction(()=>document.querySelector('#integrity-local-status')?.textContent.includes('context menu 1'));
  assert.deepEqual(integrityCalls.at(-1).data,{reference:refs.F,questionId:'q1',kind:'contextMenu'});
  await modern.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await modern.waitForTimeout(100);
  assert.equal(integrityCalls.some(call=>call.data.kind==='pageHidden'),false,'synthetic visibility events are ignored');
  await modern.evaluate(()=>{delete document.visibilityState;});
  assert.equal(integrityCalls.filter(call=>call.data.kind==='pageHidden').length,0,'synthetic hidden events do not claim a real page transition');
  await modern.locator('#next').click();
  await modern.getByText('Candidate F private prompt 842').waitFor();
  await modern.bringToFront();
  await selectText(modern,'#question-title');
  await modern.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');
  await modern.waitForFunction(()=>document.querySelector('#integrity-local-status')?.textContent.includes('copy 2'),null,{timeout:5000});
  assert.deepEqual(integrityCalls.at(-1).data,{reference:refs.F,questionId:'q2',kind:'copy'});
  assert.equal(integrityCalls.filter(call=>call.cookie===refs.F).every(call=>Object.keys(call.data).sort().join(',')==='kind,questionId,reference'),true,'no answer text, timing, focus or raw key data is sent');
  await modernContext.close();

  const emptyInvite = await context.newPage();
  await emptyInvite.goto(origin+'/#invite=');
  await emptyInvite.getByRole('status').getByText(/invitation is incomplete|could not be opened/i).waitFor();
  await noApplicantContent(emptyInvite);
  const invalidInvite = await context.newPage();
  await invalidInvite.goto(origin+'/#invite=invalid');
  await invalidInvite.getByRole('status').getByText(/could not be opened/i).waitFor();
  await noApplicantContent(invalidInvite);

  const expiryContext = await browser.newContext();
  const expiring = await expiryContext.newPage();
  await expiring.goto(link('C'));
  await expiring.getByRole('button',{name:/Review your invitation/}).click();
  await expiring.getByRole('checkbox').check();
  await expiring.getByRole('button',{name:'Start assessment'}).click();
  await expiring.getByText('Candidate C private prompt 841').waitFor();
  await expiring.context().setOffline(true);
  await expiring.getByLabel('€275').check();
  await expiring.getByText(/access window for this assessment has ended/i).waitFor({timeout:8000});
  await noApplicantContent(expiring);
  assert.equal(await expiring.evaluate(() => sessionStorage.length), 0, 'expiry removes the temporary claim');

  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  await late.goto(link('D'));
  await late.getByRole('button',{name:/Review your invitation/}).click();
  await late.getByRole('checkbox').check();
  await late.getByRole('button',{name:'Start assessment'}).click();
  await late.getByText('Candidate D private prompt 841').waitFor();
  delayAnswer = true;
  await late.getByLabel('€275').check();
  await late.getByText(/access window for this assessment has ended/i).waitFor({timeout:8000});
  await noApplicantContent(late);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await noApplicantContent(late);

  const responsive = await browser.newPage();
  await responsive.goto(origin+'/');
  for (const width of [320,390,1440]) {
    await responsive.setViewportSize({width,height:900});
    const sizes = await responsive.evaluate(() => ({width:innerWidth, scroll:document.documentElement.scrollWidth, welcome:document.querySelector('.practice-welcome').scrollWidth, spacing:getComputedStyle(document.querySelector('#landing-title')).letterSpacing}));
    assert.ok(sizes.scroll <= sizes.width, `no horizontal overflow at ${width}px: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.welcome <= sizes.width, `welcome fits at ${width}px`);
    assert.match(sizes.spacing,/^-?\d+(\.\d+)?px$/);
  }
  await responsive.close();
  await Promise.all([context.close(),expiryContext.close(),lateContext.close()]);
  console.log('PASS: Chrome candidate UI shared-tab isolation, invite validation, anonymous practice welcome, late refresh, offline expiry, late response fencing, and 320/390/1440px overflow checks.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
