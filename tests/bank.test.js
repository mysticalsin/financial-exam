import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { grade, makePaper, makePortfolioCase, reviewPaper } from '../src/bank.js';

const money = value => Number(value.replace(/[€,\s]/g, ''));
const amountsIn = text => [...text.matchAll(/€[\d,]+/g)].map(match => money(match[0]));
const percent = value => `${Number(value.toFixed(1))}%`;

function correctText(paper, question) {
  const selected = paper.key[question.id];
  assert.equal(selected.length, 1);
  return question.options.find(option => option.id === selected[0]).text;
}
test('monthly P&L supports the original figures and bounded revenue/overhead range edges', () => {
  const original = makePortfolioCase(120000, 35, 18000);
  assert.deepEqual(original.table.rows, [
    ['Revenue (client billing)', '€120,000'],
    ['Direct Costs (consultant salaries + charges)', '€78,000'],
    ['Gross Margin', '€42,000'],
    ['Allocated Overhead (office, support functions)', '€18,000'],
    ['Operating Result (Contribution)', '€24,000']
  ]);
  for (const [revenue, margin, overhead] of [[90000, 28, 7200], [300000, 46, 72000]]) {
    const sample = makePortfolioCase(revenue, margin, overhead);
    assert.equal(sample.directCosts + sample.gross, revenue);
    assert.equal(sample.contribution, sample.gross - overhead);
    assert.ok(sample.contribution > 0);
  }
});

test('each private paper has fifteen opaque questions in two sections', () => {
  const paper = makePaper();
  const ids = new Set();
  assert.deepEqual(paper.questions.map(q => q.section), [
    ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading')
  ]);
  for (const q of paper.questions) {
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options.map(o => o.text)).size, 4, q.prompt);
    assert.ok(correctText(paper, q));
    ids.add(q.id);
    for (const option of q.options) {
      assert.deepEqual(Object.keys(option).sort(), ['id', 'text']);
      ids.add(option.id);
    }
    const allowed = ['id', 'options', 'prompt', 'section'].concat(q.table ? ['table'] : []);
    assert.deepEqual(Object.keys(q).sort(), allowed.sort());
  }
  assert.equal(ids.size, 75);
  for (const id of ids) assert.match(id, /^[a-f\d-]{36}$/i);
  assert.deepEqual(Object.keys(paper.key).sort(), paper.questions.map(q => q.id).sort());
});

test('explanations stay off the issued questions and agree with the grade', () => {
  const paper = makePaper();
  assert.equal(Object.keys(paper.explanations).length, 15);
  for (const question of paper.questions) {
    const pair = paper.explanations[question.id];
    assert.equal(typeof pair.good, 'string');
    assert.notEqual(pair.good, pair.bad);
    assert.equal(JSON.stringify(question).includes(pair.good), false);
    assert.equal(JSON.stringify(question).includes(pair.bad), false);
    assert.equal(Object.hasOwn(question, 'correct'), false);
    assert.equal(Object.hasOwn(question, 'explanations'), false);
  }
  const perfect = reviewPaper(paper, paper.key);
  assert.ok(perfect.every(item => item.outcome === 'good' && item.explanation === paper.explanations[item.id].good));
  const wrong = Object.fromEntries(paper.questions.map(q => [q.id, [q.options.find(o => o.id !== paper.key[q.id][0]).id]]));
  assert.ok(reviewPaper(paper, wrong).every(item => item.outcome === 'bad' && item.explanation === paper.explanations[item.id].bad));
  assert.ok(reviewPaper(paper, {}).every(item => item.outcome === 'unanswered'));
  assert.equal(perfect.filter(item => item.outcome === 'good').length, grade(paper, paper.key));
});

test('grading accepts only the issued option for each question and gives no partial credit', () => {
  const paper = makePaper();
  const [first, second, third, fourth] = paper.questions;
  assert.equal(grade(paper, paper.key), 15);
  assert.equal(grade(paper, {}), 0);
  assert.equal(grade(paper, null), 0);
  const answers = structuredClone(paper.key);
  answers[first.id] = [paper.key[first.id][0], paper.key[first.id][0]];
  answers[second.id] = [paper.key[third.id][0]];
  answers[third.id] = true;
  delete answers[fourth.id];
  answers.score = 15;
  assert.equal(grade(paper, answers), 11);
  assert.equal(grade(makePaper(), paper.key), 0);
});

test('hiring bank is a fixed server-side catalog of at least 150 questions', async () => {
  const { HIRING_BANK } = await import('../src/bank.js');
  assert.ok(Array.isArray(HIRING_BANK), 'the hiring catalog must be exported from the worker bank');
  assert.ok(HIRING_BANK.length >= 150, `bank has ${HIRING_BANK?.length ?? 0} questions`);
  assert.ok(HIRING_BANK.length <= 220, `bank has ${HIRING_BANK.length} questions`);
  const prompts = HIRING_BANK.map(item => item.prompt);
  assert.equal(new Set(prompts).size, prompts.length, 'every bank prompt is unique');
  const foundations = HIRING_BANK.filter(item => item.section === 'Foundations');
  const applied = HIRING_BANK.filter(item => item.section === 'Applied Reading');
  assert.ok(foundations.length >= 40 && applied.length >= 40, 'both sections are deep enough to rotate');
  const visible = HIRING_BANK.map(item => JSON.stringify({
    prompt: item.prompt,
    choices: [item.correct, ...item.alternatives],
    table: item.table ?? null,
  })).join('\n');
  for (const item of HIRING_BANK) {
    assert.equal(item.alternatives.length, 3, item.prompt);
    assert.equal(new Set([item.correct, ...item.alternatives]).size, 4, item.prompt);
    assert.equal(visible.includes(item.explanations.good), false, item.prompt);
    assert.equal(visible.includes(item.explanations.bad), false, item.prompt);
    assert.equal(item.prompt.includes('"key":'), false);
    assert.equal(item.prompt.includes('"correct":'), false);
    assert.equal(item.prompt.includes('"explanation":'), false);
  }
});

test('each attempt samples a different 15-question set and omits some bank items', async () => {
  const { HIRING_BANK } = await import('../src/bank.js');
  const bankPrompts = new Set(HIRING_BANK.map(item => item.prompt));
  const papers = Array.from({ length: 24 }, () => makePaper());
  const sets = new Set();
  let omittedCanonical = false;
  for (const paper of papers) {
    assert.equal(paper.questions.length, 15);
    assert.deepEqual(paper.questions.map(question => question.section), [
      ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading'),
    ]);
    const prompts = paper.questions.map(question => question.prompt);
    for (const prompt of prompts) assert.ok(bankPrompts.has(prompt), `issued prompt is outside the bank: ${prompt}`);
    sets.add(JSON.stringify([...prompts].sort()));
    if (!prompts.includes('What does P&L stand for?')) omittedCanonical = true;
    assert.equal(grade(paper, paper.key), 15);
    const visible = JSON.stringify(paper.questions);
    for (const pair of Object.values(paper.explanations)) {
      assert.equal(visible.includes(pair.good), false);
      assert.equal(visible.includes(pair.bad), false);
    }
  }
  assert.equal(sets.size, papers.length, 'sampled attempts must not repeat a question set');
  assert.ok(omittedCanonical, 'rotation must leave some bank questions off an attempt');
  const union = new Set(papers.flatMap(paper => paper.questions.map(question => question.prompt)));
  assert.ok(union.size > 40, `only ${union.size} distinct prompts appeared`);
  assert.ok(union.size < HIRING_BANK.length);
});

test('catalog arithmetic matches the issued choices and source items stay in the bank', async () => {
  const { HIRING_BANK } = await import('../src/bank.js');
  const byPrompt = new Map(HIRING_BANK.map(item => [item.prompt, item]));
  const sourceChoices = [
    ['What does P&L stand for?', ['Planning & Logistics', 'Profit & Liquidity', 'Profit & Loss', 'Performance & Leverage'], 'Profit & Loss'],
    ['At Amaris, Revenue is primarily generated by:', ['The number of consultants hired', "Billing consultants' services to clients at an agreed daily or monthly rate", 'The number of contracts signed per year', 'The overhead charged to support functions'], "Billing consultants' services to clients at an agreed daily or monthly rate"],
    ['In consulting, Gross Margin is best defined as:', ['Total revenue before any deductions', 'Revenue minus all company overhead and administrative costs', 'Revenue from client billing minus the direct cost of the consultants (salaries + charges)', 'Net income after taxes'], 'Revenue from client billing minus the direct cost of the consultants (salaries + charges)'],
    ['As a Business Manager at Amaris, which of the following is considered a direct cost on your P&L?', ['The rent of the Amaris head office', 'The salary and social charges of your billable consultants', 'The marketing budget of the Amaris brand', "The CEO's compensation"], 'The salary and social charges of your billable consultants'],
    ['One of your consultants is on the bench (not currently billed to any client) for a full month. Their salary is still being paid. What is the direct impact on your Gross Margin?', ['No impact, since the consultant is still employed', 'Gross Margin improves because there is no billing to manage', 'Gross Margin decreases, as you bear the cost without generating revenue from this consultant', 'Gross Margin increases because the consultant is available'], 'Gross Margin decreases, as you bear the cost without generating revenue from this consultant'],
    ['As a Business Manager, which of the following actions has the most direct positive impact on your Gross Margin?', ['Reducing the number of internal meetings', 'Placing a bench consultant quickly at a billing rate above their cost', 'Requesting a lower office space allocation', 'Hiring a new support profile in your team'], 'Placing a bench consultant quickly at a billing rate above their cost'],
  ];
  for (const [prompt, choices, correct] of sourceChoices) {
    const item = byPrompt.get(prompt);
    assert.ok(item, prompt);
    assert.deepEqual([item.correct, ...item.alternatives].sort(), [...choices].sort());
    assert.equal(item.correct, correct);
  }
  const canonicalDaily = byPrompt.get('A consultant is billed to a client at €800/day. Their internal daily cost (salary + employer charges) is €500/day. What is the Gross Margin per day?');
  assert.equal(canonicalDaily.correct, '€300');
  const canonicalRate = byPrompt.get('A consultant bills €800 per day and costs €500 per day. What is the Gross Margin %?');
  assert.equal(canonicalRate.correct, '37.5%');
  let consultantLowerBillingWins = 0;
  let consultantHigherBillingWins = 0;
  let alphaWins = 0;
  let betaWins = 0;
  let highRateLowerRevenue = 0;
  let highRateHigherRevenue = 0;
  for (const item of HIRING_BANK) {
    const choices = [item.correct, ...item.alternatives];
    if (item.prompt.startsWith('A consultant is billed to a client at ')) {
      const [billing, cost] = amountsIn(item.prompt);
      assert.equal(item.correct, `€${(billing - cost).toLocaleString('en-GB')}`);
      assert.ok(choices.includes(`€${billing.toLocaleString('en-GB')}`));
    } else if (item.prompt.startsWith('A consultant bills ')) {
      const [billing, cost] = amountsIn(item.prompt);
      assert.equal(item.correct, percent((billing - cost) / billing * 100));
    } else if (item.prompt.startsWith('You manage a team of ')) {
      const team = Number(item.prompt.match(/team of (\d+)/)[1]);
      const [monthlyBilling, directCost] = amountsIn(item.prompt);
      assert.equal(item.correct, `€${(team * monthlyBilling - directCost).toLocaleString('en-GB')}`);
    } else if (item.prompt.startsWith('What is the Gross Margin % for ')) {
      const rows = new Map(item.table.rows.map(([label, value]) => [label, money(value)]));
      const revenue = rows.get('Revenue (client billing)');
      const direct = rows.get('Direct Costs (consultant salaries + charges)');
      const gross = rows.get('Gross Margin');
      const overhead = rows.get('Allocated Overhead (office, support functions)');
      const contribution = rows.get('Operating Result (Contribution)');
      assert.equal(gross, revenue - direct);
      assert.equal(contribution, gross - overhead);
      assert.equal(item.correct, percent(gross / revenue * 100));
      assert.deepEqual(new Set(choices), new Set([
        percent(gross / revenue * 100),
        percent(direct / revenue * 100),
        percent(contribution / revenue * 100),
        percent(overhead / revenue * 100),
      ]));
    } else if (item.prompt.startsWith('One consultant (monthly cost: ')) {
      const rows = new Map(item.table.rows.map(([label, value]) => [label, money(value)]));
      const [benchCost, benchBilling] = amountsIn(item.prompt);
      const gross = rows.get('Gross Margin');
      assert.ok(rows.get('Revenue (client billing)') > benchBilling);
      assert.ok(rows.get('Direct Costs (consultant salaries + charges)') > benchCost);
      assert.equal(item.correct, `€${(gross - benchBilling).toLocaleString('en-GB')}`);
    } else if (item.prompt.startsWith('A client asks you to reduce the billing rate by ')) {
      const [rateBilling, rateCost] = amountsIn(item.prompt);
      const discount = Number(item.prompt.match(/by (\d+)%/)[1]);
      const before = rateBilling - rateCost;
      const after = before - rateBilling * discount / 100;
      assert.equal(item.correct, `It changes from €${before.toLocaleString('en-GB')} to €${after.toLocaleString('en-GB')}.`);
    } else if (item.prompt.startsWith('You have two consultants in your portfolio')) {
      const headers = item.table.headers.slice(1);
      const rows = new Map(item.table.rows.map(([label, ...values]) => [label, values.map(money)]));
      const rates = rows.get('Monthly Billing').map((value, index) => (value - rows.get('Monthly Cost')[index]) / value * 100);
      assert.notEqual(rates[0], rates[1]);
      const winner = rates[0] > rates[1] ? 0 : 1;
      assert.equal(item.correct, headers[winner]);
      assert.ok(choices.every(choice => !/%/.test(choice)));
      if (rows.get('Monthly Billing')[winner] < rows.get('Monthly Billing')[1 - winner]) consultantLowerBillingWins++;
      else consultantHigherBillingWins++;
    } else if (item.prompt.startsWith('You are comparing two Business Managers')) {
      const headers = item.table.headers.slice(1);
      const rows = new Map(item.table.rows.map(([label, ...values]) => [label, values.map(money)]));
      const rates = rows.get('Gross Margin').map((value, index) => value / rows.get('Revenue')[index] * 100);
      assert.notEqual(rates[0], rates[1]);
      const winner = rates[0] > rates[1] ? 0 : 1;
      assert.equal(item.correct, headers[winner]);
      assert.ok(choices.every(choice => !/%/.test(choice)));
      if (winner === 0) alphaWins++; else betaWins++;
      if (rows.get('Revenue')[0] !== rows.get('Revenue')[1]) {
        if ((rates[0] > rates[1]) === (rows.get('Revenue')[0] > rows.get('Revenue')[1])) highRateHigherRevenue++;
        else highRateLowerRevenue++;
      }
    }
  }
  assert.ok(consultantLowerBillingWins > 0 && consultantHigherBillingWins > 0);
  assert.ok(alphaWins > 0 && betaWins > 0);
  assert.ok(highRateLowerRevenue > 0 && highRateHigherRevenue > 0);
});

test('public client files do not contain hiring explanations or the bank module', async () => {
  const { HIRING_BANK } = await import('../src/bank.js');
  const files = ['public/index.html', 'public/app.js', 'public/practice.js', 'public/invite.js', 'public/review/review.js'];
  const sources = await Promise.all(files.map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
  const bundle = sources.join('\n');
  assert.doesNotMatch(bundle, /hiring-bank|HIRING_BANK|makePaper/);
  const practice = await readFile(new URL('../src/practice.js', import.meta.url), 'utf8');
  assert.doesNotMatch(practice, /hiring-bank|HIRING_BANK/);
  for (const item of HIRING_BANK) {
    assert.equal(bundle.includes(item.explanations.good), false, item.explanations.good);
    assert.equal(bundle.includes(item.explanations.bad), false, item.explanations.bad);
    assert.equal(bundle.includes(item.prompt), false, item.prompt);
  }
});

test('both sections and option positions are randomized without changing issued grading', () => {
  const papers = Array.from({ length: 40 }, () => makePaper());
  const signatures = papers.map(p => p.questions.map(q => q.prompt).join('|'));
  assert.ok(new Set(signatures).size > 1);
  const placements = papers.flatMap(p => p.questions.map(q => q.options.findIndex(o => o.id === p.key[q.id][0])));
  assert.equal(new Set(placements).size, 4);
  for (const paper of papers) assert.equal(grade(paper, paper.key), 15);
});
