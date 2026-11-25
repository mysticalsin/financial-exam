import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const browser = await chromium.launch({
  headless:true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHROMIUM_CHANNEL} : {})
});
const origin = 'https://assessment.example.invalid';
const reference = '1'.repeat(32);
const calls = [];
let erased = false;
let delayIssue = false;
let delayLookup = false;
let issueGate;
let lookupGate;
let failLookup = false;
let expiredLookup = false;
let failIssue = false;
let recruitmentEnabled = true;
let configAvailable = true;
let whoamiMode = 'allow';
let denyOps = false;
let responseStatus = 'submitted';
let copyShortcutCount = 2;
let includeCopyShortcutCount = true;
let includeIntegritySummary = false;
let modernNotice = false;
let integritySummaryValue = {copy:2,contextMenu:1,pageHidden:0,rejectedAnswer:1};
function controlledGate() {
  let started, release;
  return {started:new Promise(resolve => started=resolve), wait:new Promise(resolve => release=resolve), markStarted:() => started(), release:() => release()};
}
const responseForRecord = (purgeAt = Date.now()+60000) => ({reference,status:responseStatus,score:1,total:1,purgeAt,
  durationMinutes:40,inviteExpiresAt:Date.now()+20*60000,
  ...(responseStatus === 'invited' ? {} : {deadline:Date.now()+40*60000,startedAt:Date.now()}),
  referenceTable:{headers:['Line','Revenue'],rows:[['Revenue','€900,000'],['Team A','€300,000'],['Team B','€300,000'],['Team C','€300,000'],['Team D','€0']]},
  ...(includeCopyShortcutCount ? {copiedQuestionCount:copyShortcutCount} : {}),
  notice: modernNotice ? {integrityReview:true} : {copyShortcutReview:includeCopyShortcutCount},
  ...(includeIntegritySummary ? {integritySummary:integritySummaryValue} : {}),
  responses:[
    {question:'Fictional arithmetic',table:{headers:['Metric','Value'],rows:[['Revenue (client billing)','€120,000'],['Direct Costs (consultant salaries + charges)','€78,000'],['Gross Margin','€42,000'],['Overhead','€18,000'],['Contribution','€24,000']]},selected:['€10'],expected:['€10']},
    {question:'Fictional subtraction',selected:['€20'],expected:['€10']},
    {question:'Fictional margin',selected:[],expected:['€10']},
  ]});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin);
    if (url.pathname === '/mantu-icon.svg') return route.fulfill({contentType:'image/svg+xml',body:await readFile(new URL('../public/mantu-icon.svg',import.meta.url))});
    if (url.pathname.startsWith('/review/')) {
      const name = url.pathname.split('/').pop() || 'index.html';
      assert.ok(['index.html','review.js','review.css'].includes(name));
      return route.fulfill({
        contentType:{'index.html':'text/html','review.js':'text/javascript','review.css':'text/css'}[name],
        body:await readFile(new URL('../public/review/' + name,import.meta.url))
      });
    }
    calls.push([req.method(),url.pathname]);
    let json;
    if (url.pathname === '/api/ops/whoami') {
      if (whoamiMode === 'html') return route.fulfill({status:200,contentType:'text/html',body:'<html>Access</html>'});
      if (whoamiMode === 'deny') return route.fulfill({status:403,json:{error:'Reviewer sign-in required.'},headers:{Date:new Date().toUTCString()}});
      json={authorized:true};
    }
    else if (url.pathname === '/api/config') {
      if (!configAvailable) return route.fulfill({status:503,json:{error:'Settings unavailable'},headers:{Date:new Date().toUTCString()}});
      json={enabled:recruitmentEnabled,durationMinutes:30,inviteTtlMinutes:30,countries:['FR','BR']};
    }
    else if (url.pathname === '/api/ops/invites') {
      if (failIssue) { failIssue=false; return route.fulfill({status:503,json:{error:'Synthetic invitation failure'},headers:{Date:new Date().toUTCString()}}); }
      assert.deepEqual(req.postDataJSON(),{country:'BR',durationMinutes:40});
      json={reference,invite:reference+'.'+'2'.repeat(64),expiresAt:Date.now()+60000,durationMinutes:40,hardEnd:Date.now()+3600000};
      if (delayIssue) { delayIssue=false; const gate=issueGate; gate.markStarted(); await gate.wait; }
    } else if (url.pathname === '/api/ops/attempts/'+reference) {
      if (denyOps) return route.fulfill({status:403,json:{error:'Reviewer sign-in required.'},headers:{Date:new Date().toUTCString()}});
      if (req.method()==='DELETE') {assert.deepEqual(req.postDataJSON(),{});erased=true;json={erased:true};}
      else {
        if (failLookup) { failLookup=false; return route.fulfill({json:{error:'Synthetic reviewer lookup failure'},status:503,headers:{Date:new Date().toUTCString()}}); }
        if (delayLookup) { delayLookup=false; const gate=lookupGate; gate.markStarted(); await gate.wait; }
        json=expiredLookup ? responseForRecord(Date.now()-1000) : responseForRecord();
        expiredLookup=false;
      }
    } else throw new Error('Unexpected route');
    return route.fulfill({json,headers:{Date:new Date().toUTCString()}});
  });
  await page.goto(origin+'/review/');
  await page.getByText(/up to 30 minutes/).waitFor();
  assert.match(await page.locator('#minutes-help').innerText(),/start-by/i);
  assert.match(await page.locator('#minutes-help').innerText(),/not the exam clock/i);
  await page.locator('#country').selectOption('BR');
  await page.getByLabel('Exam length in minutes').fill('40');
  await page.getByRole('button',{name:'Create invitation'}).click();
  await page.locator('#issued').waitFor();
  assert.ok((await page.locator('#invite').inputValue()).startsWith(origin+'/#invite='));
  const issuedNote = await page.locator('#issued-note').innerText();
  assert.match(issuedNote,/40 minutes/);
  assert.match(issuedNote,/open this link before/i);
  assert.match(issuedNote,/not the exam clock/i);
  assert.match(await page.locator('#status').innerText(),/not the exam clock/i);
  await page.getByRole('button',{name:'Clear link'}).click();
  assert.equal(await page.locator('#invite').inputValue(),'');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  const recordText = await page.locator('#record').innerText();
  assert.match(recordText,/Exam length/);
  assert.match(recordText,/Exam clock ends/);
  assert.match(recordText,/Invitation start-by/);
  assert.match(recordText,/not the exam clock/i);
  assert.match(recordText,/Scheduled erasure/);
  assert.match(await page.locator('.copy-shortcut-context').innerText(),/2 distinct questions reported/);
  assert.match(await page.locator('.copy-shortcut-context').innerText(),/cannot establish outside assistance/);
  await page.getByRole('button',{name:'Incorrect',exact:true}).click();
  assert.equal(await page.locator('.response-list details').count(),1,'incorrect filter shows only mismatches');
  await page.getByRole('button',{name:'Unanswered',exact:true}).click();
  assert.equal(await page.locator('.response-list details').count(),1,'unanswered filter handles empty selected arrays');
  await page.getByRole('button',{name:'Correct',exact:true}).click();
  assert.equal(await page.locator('.response-list details').count(),1,'correct filter compares complete choice sets');
  await page.getByRole('button',{name:'All',exact:true}).click();
  assert.equal(await page.locator('.response-list details').count(),3);
  await page.getByText('Fictional arithmetic').click();
  await page.getByRole('cell',{name:'€120,000'}).waitFor();
  const learningPrompt=await page.locator('.learning-prompt').innerText();
  assert.match(learningPrompt,/€120,000 revenue and €78,000 direct costs/);
  assert.match(learningPrompt,/gross margin in euros and as a percentage/);
  await page.getByRole('button',{name:'Erase record…'}).click();
  assert.equal(erased,false);
  await page.getByRole('button',{name:'Cancel'}).click();
  assert.equal(erased,false);
  await page.getByRole('button',{name:'Erase record…'}).click();
  await page.getByRole('button',{name:'Confirm erasure'}).click();
  await page.getByText('Assessment record erased.').waitFor();
  assert.equal(erased,true);
  assert.equal(await page.getByLabel('Assessment reference').inputValue(),'');
  assert.equal(await page.getByText('Fictional arithmetic').count(),0);
  assert.equal(calls.filter(x=>x[0]==='DELETE').length,1);

  includeIntegritySummary=true; modernNotice=true; includeCopyShortcutCount=false;
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  const summaryText=await page.locator('.integrity-summary').innerText();
  assert.match(summaryText,/Native copy events\s*2/);
  assert.match(summaryText,/Question context menus\s*1/);
  assert.match(summaryText,/Assessment page became hidden\s*0/);
  assert.match(summaryText,/Answer choices rejected\s*1/);
  assert.match(summaryText,/can overlap/);
  assert.match(summaryText,/ask about the relevant question, calculation steps, tools or any technical issue/i);
  assert.match(summaryText,/do not score the candidate/);
  integritySummaryValue={copy:0};
  await page.getByLabel('Assessment reference').fill('');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  const partialSummary=await page.locator('.integrity-summary').innerText();
  assert.match(partialSummary,/Native copy events\s*0/);
  assert.match(partialSummary,/Question context menus\s*Unavailable/,'missing values are unavailable, not shown as zero');
  includeIntegritySummary=false; modernNotice=false; includeCopyShortcutCount=true;

  responseStatus='expired';
  copyShortcutCount=0;
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  const zeroContext=await page.locator('.copy-shortcut-context').innerText();
  assert.match(zeroContext,/0 distinct questions reported/);
  assert.match(zeroContext,/zero is not proof that none occurred/i,'zero means no signal was reported, not complete observation');
  assert.match(zeroContext,/cannot establish outside assistance/);

  responseStatus='submitted';
  includeCopyShortcutCount=false;
  await page.getByLabel('Assessment reference').fill('');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  assert.equal(await page.locator('.copy-shortcut-context').count(),0,'legacy or disabled records omit the context line');
  assert.match(await page.locator('.integrity-unavailable').innerText(),/not enabled/);
  modernNotice=true;
  await page.getByLabel('Assessment reference').fill('');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  assert.match(await page.locator('.integrity-unavailable').innerText(),/unavailable/,'a missing modern summary is unavailable, not zero');
  modernNotice=false;
  includeCopyShortcutCount=true;
  responseStatus='active';
  await page.getByLabel('Assessment reference').fill('');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('Hidden until the attempt is submitted or the exam clock ends.').first().waitFor();
  assert.equal(await page.getByText('1 / 1',{exact:true}).count(),0,'an active record does not show a score');
  assert.equal(await page.getByText('€10').count(),0,'an active record does not show expected answers');
  assert.equal(await page.locator('.response-list details').count(),0,'an active record does not list responses');
  assert.equal(await page.locator('.learning-prompt').count(),0,'an active record does not offer the learning prompt');
  assert.equal(await page.locator('.copy-shortcut-context').count(),0,'active assessment records do not show a completed-result context line');
  responseStatus='invited';
  await page.getByLabel('Assessment reference').fill('');
  await page.getByLabel('Assessment reference').fill(reference.toUpperCase());
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('Not started.').waitFor();
  assert.equal(await page.locator('#ref').inputValue(),reference,'a pasted uppercase reference is looked up in lowercase');
  assert.equal(await page.getByText('€10').count(),0,'an unused invitation does not show an answer key');
  assert.match(await page.locator('#record').innerText(),/before the start-by time/i);
  responseStatus='submitted';
  await page.getByLabel('Assessment reference').fill('');

  const setVisibility = async state => page.evaluate(state => {
    Object.defineProperty(document,'visibilityState',{configurable:true,value:state});
    document.dispatchEvent(new Event('visibilitychange'));
  },state);
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Erase record…'}).click();
  assert.equal(await page.locator('#confirm').isVisible(),true);
  assert.equal(await page.locator('#confirm').getAttribute('open'),'','erasure confirmation is a modal dialog');
  await page.evaluate(() => {
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    window.dispatchEvent(new Event('pagehide'));
  });
  assert.equal(await page.locator('#confirm').isVisible(),false,'pagehide must close an open confirmation dialog');
  assert.equal(await page.locator('#result').isVisible(),false,'pagehide clears the open record');
  await setVisibility('visible');
  delayIssue=true;
  issueGate=controlledGate();
  await page.getByRole('button',{name:'Create invitation'}).click();
  await issueGate.started;
  await page.evaluate(() => {
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    window.dispatchEvent(new Event('pagehide'));
  });
  assert.equal(await page.locator('#issued').isVisible(),false);
  assert.equal(await page.locator('#invite').inputValue(),'');
  issueGate.release();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#issued').isVisible(),false,'late issue response must not restore private link');
  await setVisibility('visible');

  failLookup=true;
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('Synthetic reviewer lookup failure').waitFor();
  assert.equal(await page.locator('#result').isVisible(),false,'visible request failures remain available to the operator');

  delayLookup=true;
  lookupGate=controlledGate();
  await page.getByRole('button',{name:'Find assessment'}).click();
  await lookupGate.started;
  await setVisibility('hidden');
  assert.equal(await page.locator('#ref').inputValue(),'');
  assert.equal(await page.locator('#confirm').isVisible(),false);
  lookupGate.release();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#result').isVisible(),false,'late lookup response must not restore an assessment');
  await setVisibility('visible');

  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Erase record…'}).click();
  assert.equal(await page.locator('#confirm').isVisible(),true);
  await page.evaluate(() => { window.__nativeDateNow=Date.now; Date.now=()=>window.__nativeDateNow()+120000; });
  await setVisibility('visible');
  assert.equal(await page.locator('#result').isVisible(),false,'wall-clock elapsed during sleep must enforce expiry on resume');
  assert.equal(await page.locator('#confirm').isVisible(),false,'expiry must close the erase dialog');
  assert.equal(await page.getByLabel('Assessment reference').inputValue(),'','expiry must clear the reference input');
  await page.evaluate(() => { Date.now=window.__nativeDateNow; delete window.__nativeDateNow; });
  await setVisibility('visible');

  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('The system clock changed. Re-enter the reference to continue.').waitFor();
  assert.equal(await page.locator('#result').isVisible(),false,'a wall-clock rollback must clear prior state');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  await page.evaluate(() => { window.__nativeDateNow=Date.now; Date.now=()=>window.__nativeDateNow()-120000; });
  await setVisibility('visible');
  assert.equal(await page.locator('#result').isVisible(),false,'a backward system clock change must fail closed');
  await page.evaluate(() => { Date.now=window.__nativeDateNow; delete window.__nativeDateNow; });

  delayLookup=true;
  expiredLookup=true;
  lookupGate=controlledGate();
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await lookupGate.started;
  // A response arriving after its server cutoff must never repopulate the page.
  lookupGate.release();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#result').isVisible(),false,'expired lookup response must not restore the record');
  includeIntegritySummary=true; modernNotice=true; integritySummaryValue={copy:0,contextMenu:0,pageHidden:0,rejectedAnswer:0};
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(layout.scroll<=layout.width,`reviewer layout fits at 390px: ${JSON.stringify(layout)}`);
  await page.locator('.integrity-summary').waitFor();
  await page.getByRole('button',{name:'Incorrect',exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.response-list details').count(),1,'reviewer filters work from the keyboard at mobile width');
  const pressedContrast = await page.locator('.response-filters button[aria-pressed=true]').evaluate(node => {
    const parse = color => {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
      if (!match || match[4] === '0') return null;
      return match.slice(1, 4).map(Number);
    };
    const channel = value => {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = rgb => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    const ratio = (left, right) => {
      const light = Math.max(luminance(left), luminance(right));
      const dark = Math.min(luminance(left), luminance(right));
      return (light + 0.05) / (dark + 0.05);
    };
    const style = getComputedStyle(node);
    let background = parse(style.backgroundColor);
    let surface = node.parentElement;
    let behind = null;
    while (surface) {
      behind = parse(getComputedStyle(surface).backgroundColor);
      if (behind) break;
      surface = surface.parentElement;
    }
    return {
      text: ratio(parse(style.color), background),
      outline: ratio(parse(style.outlineColor), behind || [255, 255, 255]),
    };
  });
  assert.ok(pressedContrast.text >= 4.5, `pressed filter text contrast is ${pressedContrast.text.toFixed(2)}`);
  assert.ok(pressedContrast.outline >= 3, `pressed filter indicator contrast is ${pressedContrast.outline.toFixed(2)}`);
  for (let step = 0; step < 6; step++) {
    if (await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY')) break;
    await page.keyboard.press('Tab');
  }
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY', 'keyboard reaches a response summary');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'response summary keeps a visible focus ring');
  await page.getByRole('button',{name:'All',exact:true}).click();
  await page.getByText('Fictional arithmetic').click();
  await page.getByRole('cell',{name:'€120,000'}).waitFor();
  for (const [width, height, label] of [[320, 780, '320 reviewer'], [390, 320, 'short reviewer']]) {
    await page.setViewportSize({width, height});
    const box = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
    assert.ok(box.scroll <= box.width + 1, `${label} has no horizontal overflow ${JSON.stringify(box)}`);
  }
  await page.getByRole('button',{name:'Erase record…'}).click();
  const confirmReachable = await page.getByRole('button',{name:'Confirm erasure'}).evaluate(node => {
    node.scrollIntoView({block:'nearest'});
    const rect = node.getBoundingClientRect();
    return rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.width > 40;
  });
  assert.equal(confirmReachable, true, 'erase confirmation is reachable on a short screen');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#confirm').isVisible(), false, 'Escape cancels erasure');
  await page.setViewportSize({width:1280,height:800});

  await page.getByRole('button',{name:'Create invitation'}).click();
  await page.locator('#issued').waitFor();
  const keptLink = await page.locator('#invite').inputValue();
  failIssue = true;
  await page.getByRole('button',{name:'Create invitation'}).click();
  await page.getByText('Synthetic invitation failure').waitFor();
  assert.equal(await page.locator('#invite').inputValue(), keptLink, 'a failed retry must not wipe the private link');
  assert.equal(await page.locator('#issued').isVisible(), true);

  denyOps = true;
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('Staff access is required').waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false, 'a rejected assertion closes the workspace');
  assert.equal(await page.locator('#invite').inputValue(), '', 'a rejected assertion clears the private link');
  denyOps = false;

  recruitmentEnabled = false;
  await page.goto(origin+'/review/');
  await page.locator('#access').getByText('Scored recruitment is closed').waitFor();
  assert.equal(await page.locator('#create').isVisible(), false, 'closed recruitment hides invitation creation');
  assert.match(await page.locator('#lede').innerText(), /New invitations stay off/);
  assert.match(await page.locator('#access').innerText(), /Existing records can still be retrieved and erased/);
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();

  recruitmentEnabled = true;
  configAvailable = false;
  await page.goto(origin+'/review/');
  await page.getByText('recruitment settings could not be loaded').waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), true);
  assert.equal(await page.locator('#create').isVisible(), false);
  assert.doesNotMatch(await page.locator('#access').innerText(), /Staff access is required/);

  configAvailable = true;
  whoamiMode = 'html';
  await page.goto(origin+'/review/');
  await page.getByText('Staff access is required').waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false, 'an Access login page is not the reviewer workspace');
  whoamiMode = 'allow';

  const invitePage = await browser.newPage();
  const inviteSource = await readFile(new URL('../public/invite.js', import.meta.url), 'utf8');
  await invitePage.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    if (url.pathname === '/invite.js') return route.fulfill({contentType:'text/javascript', body:inviteSource});
    if (url.pathname === '/') return route.fulfill({contentType:'text/html', body:'<!doctype html><script src="/invite.js"></script>'});
    throw new Error('Unexpected invite route ' + url.pathname);
  });
  const token = reference + '.' + 'ab'.repeat(32);
  const messy = '\n' + token.toUpperCase() + '.\n';
  await invitePage.goto(origin + '/#' + new URLSearchParams({invite:messy}).toString());
  assert.equal(await invitePage.evaluate(() => window.assessmentInvitation), token, 'a wrapped uppercase invitation normalizes to the claim token');
  assert.equal(await invitePage.evaluate(() => location.hash), '', 'the invitation fragment is removed from the address bar');
  await invitePage.goto(origin + '/?fresh=1#practice');
  assert.equal(await invitePage.evaluate(() => window.assessmentInvitation), undefined, 'an unrelated fragment is not an invitation');
  const next = 'cd'.repeat(16) + '.' + 'ef'.repeat(32);
  const loaded = invitePage.waitForEvent('load');
  try {
    await invitePage.evaluate(value => { location.hash = '#invite=' + value; }, next.toUpperCase());
  } catch (error) {
    if (!/destroyed|navigation/i.test(String(error))) throw error;
  }
  await loaded;
  assert.equal(await invitePage.evaluate(() => window.assessmentInvitation), next, 'a same-tab invitation reloads into a fresh claim');
  assert.equal(await invitePage.evaluate(() => location.hash), '');
  console.log('Reviewer browser passed visible errors, hide/pagehide clearing, stale issue and lookup suppression, simulated sleep expiry, invitation clocks, closed mode, and assessment review/erase flows (synthetic Access/API responses).');
} finally {await browser.close();}
