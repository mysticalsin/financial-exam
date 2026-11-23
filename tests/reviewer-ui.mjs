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
    if (url.pathname === '/api/ops/whoami') json={authorized:true};
    else if (url.pathname === '/api/config') json={enabled:true,durationMinutes:30,countries:['FR','BR']};
    else if (url.pathname === '/api/ops/invites') {
      assert.deepEqual(req.postDataJSON(),{country:'BR',durationMinutes:40});
      json={reference,invite:reference+'.'+'2'.repeat(64),expiresAt:Date.now()+60000};
      if (delayIssue) { delayIssue=false; const gate=issueGate; gate.markStarted(); await gate.wait; }
    } else if (url.pathname === '/api/ops/attempts/'+reference) {
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
  await page.locator('#country').selectOption('BR');
  await page.getByLabel('Time allowance in minutes').fill('40');
  await page.getByRole('button',{name:'Create invitation'}).click();
  await page.locator('#issued').waitFor();
  assert.ok((await page.locator('#invite').inputValue()).startsWith(origin+'/#invite='));
  await page.getByRole('button',{name:'Clear link'}).click();
  assert.equal(await page.locator('#invite').inputValue(),'');
  await page.getByLabel('Assessment reference').fill(reference);
  await page.getByRole('button',{name:'Find assessment'}).click();
  await page.getByText('1 / 1',{exact:true}).waitFor();
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
  await page.getByText('1 / 1',{exact:true}).waitFor();
  assert.equal(await page.locator('.copy-shortcut-context').count(),0,'active assessment records do not show a completed-result context line');
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
  assert.equal(await page.locator('#confirm').isVisible(),false,'pagehide must close an open confirmation dialog');
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
  console.log('Reviewer browser passed visible errors, hide/pagehide clearing, stale issue and lookup suppression, simulated sleep expiry, and assessment review/erase flows (synthetic Access/API responses).');
} finally {await browser.close();}
