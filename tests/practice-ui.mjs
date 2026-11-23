import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {makePracticePaper} from '../src/practice.js';

const root = new URL('../public/', import.meta.url);
const calls = [];
const startedPapers = [];
let delaySubmit = false;
const server = createServer(async (request,response) => {
  const url = new URL(request.url,'http://127.0.0.1');
  const json = (status,data,headers={}) => {response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});response.end(JSON.stringify(data));};
  const body = async () => {let text='';for await(const chunk of request)text+=chunk;return text?JSON.parse(text):{};};
  if (url.pathname.startsWith('/api/')) {
    calls.push({method:request.method,path:url.pathname,cookie:request.headers.cookie||null,reference:request.headers['x-assessment-reference']||null});
    if (url.pathname === '/api/config') return json(200,{enabled:false,durationMinutes:15,countries:[]});
    if (url.pathname === '/api/practice/start' && request.method === 'POST') {
      assert.deepEqual(await body(),{});
      const paper=makePracticePaper();
      const now=Date.now();
      const starts=startedPapers.length+1;
      const challenge=`practice-challenge-${starts}`;
      const deadline=now+(starts===5?10000:15*60000);
      startedPapers.push({paper,challenge,deadline});
      return json(200,{questions:paper.questions,referenceTable:paper.referenceTable,challenge,serverNow:now,deadline});
    }
    if (url.pathname === '/api/practice/submit' && request.method === 'POST') {
      const data=await body();
      if (delaySubmit) await new Promise(resolve=>setTimeout(resolve,12000));
      const started=startedPapers.find(item=>item.challenge===data.challenge);
      const answered=Object.keys(data.answers||{}).length;
      const score=started?Object.entries(data.answers||{}).filter(([id,choice])=>started.paper.key[id]===choice).length:0;
      return json(200,{score,total:15,answered,submittedAt:Date.now()});
    }
    return json(404,{error:'Unexpected API route'});
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!/^[a-z0-9.-]+$/i.test(file)){response.writeHead(404);return response.end();}
  try {const bytes=await readFile(new URL(file,root));const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html';response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});response.end(bytes);}
  catch {response.writeHead(404);response.end();}
});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?{channel:process.env.PLAYWRIGHT_CHROMIUM_CHANNEL}:{})});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;

const choose = async (page, question, correct, wrong=false) => {
  const choice = wrong
    ? question.options.find(option=>option.id!==correct)
    : question.options.find(option=>option.id===correct);
  assert.ok(choice,`question ${question.id} has the expected option`);
  await page.locator(`.practice-question-card[data-question-id="${question.id}"] input[value="${choice.id}"]`).check();
};
const finish = async (page) => {
  await page.locator('#practice-submit').click();
  await page.getByRole('button',{name:'Submit and see score'}).click();
};
const assertScore = async (page, expectedScore, band) => {
  await page.locator('#practice-results').waitFor();
  assert.equal(await page.getByRole('heading',{name:'Your practice result'}).count(),1);
  assert.equal(await page.locator('.score-value').innerText(),String(expectedScore));
  assert.equal(await page.locator('.result-band').innerText(),band);
  assert.equal(await page.locator('.result-answered').innerText(),'15 of 15 answered');
  assert.ok((await page.locator('.result-reflection').innerText()).length>12,'result includes one band-appropriate next-practice prompt');
  assert.equal(await page.locator(`.score-band[data-score-band="${band.toLowerCase()}"]`).getAttribute('aria-current'),'true');
  assert.equal(await page.locator('.score-band[data-score-band]').count(),4);
  assert.match(await page.locator('body').innerText(),/not (?:used for hiring|shared with recruiters)|not a hiring assessment/i);
};

try {
  const context=await browser.newContext({viewport:{width:320,height:900}});
  await context.addCookies([{name:'__Host-assessment',value:`${'a'.repeat(32)}.${'1'.repeat(64)}`,domain:'127.0.0.1',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
  assert.equal((await context.cookies(origin)).some(cookie=>cookie.name==='__Host-assessment'),true,'fixture browser begins with a shared recruitment cookie');
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin+'/');
  const assertLandingGeometry=async(width,label)=>{
    await page.setViewportSize({width,height:950});
    const blocks=await page.evaluate(()=>Array.from(document.querySelectorAll('#landing .studio-brand,#landing .welcome-eyebrow,#landing-title,#landing .welcome-subtitle,#landing .welcome-scope,#landing .studio-copy .welcome-kicker,#welcome-description,#landing .welcome-facts,#landing-action,#hero-hint,#welcome-privacy,#landing .studio-ledger'))
      .filter(node=>!node.hidden&&getComputedStyle(node).display!=='none')
      .map(node=>({selector:node.id||node.className,text:node.innerText?.slice(0,30),top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom})));
    for(let i=1;i<blocks.length;i++) assert.ok(blocks[i-1].bottom<=blocks[i].top+1,`${label} welcome blocks do not overlap: ${JSON.stringify([blocks[i-1],blocks[i]])}`);
    const cta=blocks.find(block=>block.selector==='landing-action');
    const ledger=blocks.find(block=>String(block.selector).includes('studio-ledger'));
    if(width<=680) assert.ok(cta.bottom<ledger.top,`${label} mobile CTA precedes ledger artwork`);
  };
  await assertLandingGeometry(320,'320px normal');
  if(process.env.PRACTICE_UI_SCREENSHOT_DIR){
    await mkdir(process.env.PRACTICE_UI_SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/welcome-320.png`,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/welcome-1440.png`,fullPage:true});
  }
  await assertLandingGeometry(390,'390px normal');
  if(process.env.PRACTICE_UI_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/welcome-390.png`,fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await assertLandingGeometry(390,'390px reduced motion');
  if(process.env.PRACTICE_UI_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/welcome-390-reduced.png`,fullPage:true});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:320,height:950});
  assert.equal(await page.locator('#practice-intro').isVisible(),true);
  assert.equal((await page.locator('#landing-title').innerText()).replace(/\s+/g,' ').trim(),'Financial Test');
  assert.match(await page.locator('.studio-before').innerText(),/Before you start/);
  assert.match(await page.locator('.welcome-scope').innerText(),/15 questions.*15 minutes/i);
  assert.match(await page.locator('#practice-intro').innerText(),/Calculator use is fine/);
  assert.match(await page.locator('#practice-intro').innerText(),/Review and change answers before submitting/);
  assert.equal(await page.locator('#practice-intro input').count(),0,'practice welcome asks for no identity fields');
  assert.equal(await page.locator('.studio-brand img[alt="Mantu"]').count(),1,'branded Mantu mark anchors the studio introduction');
  assert.equal(await page.locator('.ledger-row').count(),5,'landing ledger contains all five source P&L rows');
  assert.deepEqual(await page.locator('.ledger-row').evaluateAll(rows=>rows.map(row=>[row.querySelector('.ledger-label').textContent,row.querySelector('.ledger-amount').textContent])),[
    ['Revenue','€120,000'],['Direct costs','€78,000'],['Gross margin','€42,000'],['Overhead','€18,000'],['Contribution','€24,000'],
  ],'landing ledger values match the canonical P&L');
  assert.deepEqual(await page.locator('.ledger-row .ledger-track i').evaluateAll(bars=>bars.map(bar=>getComputedStyle(bar).getPropertyValue('--ledger-width').trim())),['100%','65%','35%','15%','20%'],'ledger bars use the P&L proportions');
  await page.locator('.studio-ledger.is-visible').waitFor();
  assert.equal(await page.locator('.studio-ledger .ledger-track i').evaluateAll(bars=>bars.filter(bar=>getComputedStyle(bar).animationName==='ledger-settle').length),5,'the five-row ledger animates on first reveal');
  assert.deepEqual(await page.locator('.ledger-foot').evaluate(node=>Array.from(node.children).filter(child=>!child.classList.contains('ledger-foot-rule')).map(child=>child.textContent)),['GROSS MARGIN','35%','CONTRIBUTION','20%'],'gross and contribution margins are labeled accurately');
  assert.equal(await page.evaluate(()=>sessionStorage.length+localStorage.length),0,'practice writes no browser storage');
  await page.getByRole('button',{name:/Start practice assessment/}).click();
  await page.locator('#practice-begin').waitFor();
  if(process.env.PRACTICE_UI_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/preflight-390.png`,fullPage:true});
  assert.equal(await page.getByRole('button',{name:'Not now'}).isVisible(),true,'the preflight can be dismissed without starting');
  assert.equal(startedPapers.length,0,'the clock and practice API do not start before final confirmation');
  assert.match(await page.locator('#preflight-paper-panel').innerText(),/Foundations.*Applied reading/s);
  await page.getByRole('button',{name:'Try a question'}).click();
  await page.getByRole('button',{name:'€60'}).click();
  assert.match(await page.locator('#preflight-example-feedback').innerText(),/€100 − €60 = €40/);
  assert.equal(startedPapers.length,0,'the optional warm-up stays local and untimed');
  await page.getByRole('button',{name:'Your paper'}).click();
  assert.equal(await page.locator('#practice-begin').isVisible(),true,'the begin action remains available after optional guidance');
  await page.getByRole('button',{name:'Start 15-minute practice'}).click();
  await page.locator('.practice-question-card').first().waitFor();
  const originalPaper=startedPapers[0].paper;
  assert.equal(await page.locator('.practice-question-card').count(),15,'all questions appear together');
  assert.equal(await page.locator('.practice-part-header[data-part="foundations"] .practice-question-card').count(),0,'section headers are separate from cards');
  assert.equal(await page.locator('.practice-part-header[data-part="foundations"]').count(),1);
  assert.equal(await page.locator('.practice-part-header[data-part="applied"]').count(),1);
  assert.deepEqual(await page.locator('.practice-question-number').allInnerTexts(),Array.from({length:15},(_,i)=>String(i+1).padStart(2,'0')));
  assert.deepEqual(await page.locator('.practice-question-prompt').allInnerTexts(),originalPaper.questions.map(question=>question.prompt));
  assert.equal(await page.locator('#practice-progress').evaluate(progress=>progress.value),0);
  assert.equal(await page.locator('#practice-timer').count(),1);
  assert.equal(await page.locator('.portfolio-reference .practice-table tbody tr').count(),5,'monthly portfolio reference P&L is shown in Part 2');
  assert.deepEqual(await page.locator('.portfolio-reference .practice-table tbody tr td:last-child').allInnerTexts(),['€120,000','€78,000','€42,000','€18,000','€24,000']);
  assert.deepEqual(await page.locator('.portfolio-reference .viz-key-item').evaluateAll(items=>items.map(item=>({
    label:item.querySelector('span:not(.viz-swatch)').textContent,
    amount:item.querySelector('strong').textContent,
  }))),[
    {label:'Direct costs',amount:'€78,000'},
    {label:'Gross margin',amount:'€42,000'},
    {label:'Revenue',amount:'€120,000'},
  ],'chart legend values independently match the P&L table');
  for(let q=9;q<=13;q++) assert.equal(await page.locator(`.practice-question-card[data-question-id="practice-q${q}"] .reference-cue`).count(),1,`Q${q} points to the shared portfolio figures`);
  assert.equal(await page.locator('.practice-question-card[data-question-id="practice-q12"] .practice-table').count(),1,'Q12 keeps its consultant comparison table');
  assert.equal(await page.locator('.practice-question-card[data-question-id="practice-q15"] .practice-table').count(),1,'Q15 keeps its portfolio comparison table');
  assert.equal(await page.locator('.practice-question-card input[type="radio"]').count(),60,'four native single-choice answers appear for each question');
  assert.equal(await page.locator('.practice-question-card fieldset').count(),15,'answer options are grouped by question');
  assert.ok(await page.locator('#practice-submit').isDisabled());

  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,frames:[...document.querySelectorAll('.table-scroll')].map(frame=>({frame:frame.clientWidth,table:frame.querySelector('table').scrollWidth}))}));
    assert.ok(layout.scroll<=layout.width,`paper has no page overflow at ${width}px: ${JSON.stringify(layout)}`);
    if(width<560) assert.ok(layout.frames.some(frame=>frame.table>frame.frame),`wide financial tables scroll inside their frames at ${width}px`);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  const motion=await page.locator('.studio-ledger .ledger-track i').first().evaluate(node=>getComputedStyle(node).animationDuration);
  assert.ok(motion==='0.01ms'||motion==='0s'||motion==='1e-05s',`reduced-motion mode suppresses ledger animation (${motion})`);
  assert.equal(await page.locator('#practice-nav').isVisible(),true,'desktop question navigator is available');
  assert.equal(await page.locator('#practice-jump').isVisible(),true,'labeled question jump control is available');
  assert.deepEqual(await page.locator('[data-practice-filter]').evaluateAll(items=>items.map(item=>[item.dataset.practiceFilter,item.querySelector('[data-filter-count]').textContent])),[['all','15'],['answered','0'],['unanswered','15']]);
  await page.locator('[data-practice-filter="answered"]').click();
  assert.equal(await page.locator('#practice-filter-empty').isVisible(),true,'an empty filter has a distinct message');
  await page.getByRole('button',{name:'Show all questions'}).click();
  await page.setViewportSize({width:390,height:900});
  const first=originalPaper.questions[0];
  await choose(page,first,originalPaper.key[first.id],true);
  assert.equal(await page.locator('#practice-progress').evaluate(progress=>progress.value),1);
  assert.equal(await page.locator('[data-practice-filter="answered"] [data-filter-count]').innerText(),'1','answer status filter counts update live');
  await page.locator('[data-practice-filter="answered"]').click();
  assert.equal(await page.locator('.practice-question-card:visible').count(),1,'answered filter retains the selected answer card');
  await page.locator('[data-practice-filter="unanswered"]').click();
  assert.equal(await page.locator('.practice-question-card:visible').count(),14,'unanswered filter shows only questions without answers');
  await page.locator('[data-practice-filter="all"]').click();
  await choose(page,first,originalPaper.key[first.id]);
  assert.equal(await page.locator('#practice-progress').evaluate(progress=>progress.value),1,'changing a selected answer does not double-count the question');
  for(const [index,question] of originalPaper.questions.entries()) await choose(page,question,originalPaper.key[question.id],index<2);
  assert.equal(await page.locator('#practice-progress').evaluate(progress=>progress.value),15);
  assert.equal(await page.locator('#practice-answered').innerText(),'15 of 15 answered');
  assert.ok(await page.locator('#practice-submit').isEnabled());
  await page.locator('#practice-submit').click();
  await page.getByRole('button',{name:'Keep reviewing'}).click();
  assert.equal(await page.locator('.practice-question-card').count(),15,'all cards remain editable before final submission');
  await finish(page);
  await assertScore(page,13,'Excellent');
  if(process.env.PRACTICE_UI_SCREENSHOT_DIR){
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/result-1440.png`,fullPage:true});
    await page.setViewportSize({width:390,height:900});
    await page.screenshot({path:`${process.env.PRACTICE_UI_SCREENSHOT_DIR}/result-390.png`,fullPage:true});
  }
  assert.equal(calls.filter(call=>call.path==='/api/practice/submit').length,1);

  for(const [desired,band] of [[10,'Good'],[7,'Average'],[6,'Insufficient']]){
    await page.getByRole('button',{name:'Retake practice assessment'}).click();
    await page.locator('.practice-question-card').first().waitFor();
    const nextPaper=startedPapers.at(-1).paper;
    assert.equal(await page.locator('#practice-results').count(),0,'retake clears the previous score before the new paper');
    for(const [index,question] of nextPaper.questions.entries()) await choose(page,question,nextPaper.key[question.id],index<15-desired);
    await finish(page);
    await assertScore(page,desired,band);
  }
  assert.ok(calls.every(call=>call.path==='/api/config'||call.path.startsWith('/api/practice/')),'public practice calls only its practice endpoints and public config');
  assert.ok(calls.every(call=>call.cookie===null&&call.reference===null),'practice requests do not send candidate cookies or references');
  assert.equal(await context.cookies(origin).then(cookies=>cookies.some(cookie=>cookie.name==='__Host-assessment')),true,'practice leaves the pre-existing recruitment cookie untouched');
  assert.equal(await page.evaluate(()=>sessionStorage.length+localStorage.length),0,'scores and answers remain out of browser storage');
  await page.reload();
  await page.getByRole('button',{name:/Start practice assessment/}).waitFor();
  assert.equal(await page.locator('#practice-results').count(),0,'reload clears the in-memory practice score');

  const late=await context.newPage();
  await late.goto(origin+'/');
  await late.getByRole('button',{name:/Start practice assessment/}).click();
  await late.getByRole('button',{name:'Start 15-minute practice'}).click();
  await late.locator('.practice-question-card').first().waitFor();
  const latePaper=startedPapers.at(-1).paper;
  for(const question of latePaper.questions) await choose(late,question,latePaper.key[question.id]);
  await late.locator('#practice-submit').click();
  await late.getByRole('button',{name:'Submit and see score'}).waitFor();
  delaySubmit=true;
  await late.getByRole('button',{name:'Submit and see score'}).click();
  await late.getByRole('heading',{name:'Practice time ended'}).waitFor({timeout:15000});
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(await late.locator('#practice-results').count(),0,'a late grade response cannot revive an expired result');
  assert.equal(pageErrors.length,0,`no browser errors: ${pageErrors.join('; ')}`);
  await context.close();
  console.log('PASS: Chrome redesigned Mantu studio, source-matched 15-question practice, preflight timing, 8+7 sections, accessible question navigation and status filters, 60 choices, P&L reference/comparison tables, progress, editable review, four score bands, randomized retake, privacy, reduced motion, 320/390/1440px layouts, and late grade expiry.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
