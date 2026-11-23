import assert from 'node:assert/strict';
import test from 'node:test';
import { clientQuestion, drawPracticePaper, grade, makePaper, makePortfolioCase, questionBank } from '../src/bank.js';

const euroFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const euros = value => '€' + euroFormatter.format(value);
const percent = value => Number(value.toFixed(1)) + '%';
const money = value => Number(String(value).replace(/[€,\s]/g, ''));

function correctText(paper, question) {
  const selected = paper.key[question.id];
  const optionId = Array.isArray(selected) ? selected[0] : selected;
  return question.options.find(option => option.id === optionId).text;
}

function expectedFromFigures(figures) {
  switch (figures.kind) {
    case 'daily-euro':
      return euros(figures.billing - figures.cost);
    case 'daily-percent':
      return percent((figures.billing - figures.cost) / figures.billing * 100);
    case 'team-euro':
      return euros(figures.headcount * figures.billingPerConsultant - figures.directCosts);
    case 'team-percent': {
      const revenue = figures.headcount * figures.billingPerConsultant;
      return percent((revenue - figures.directCosts) / revenue * 100);
    }
    case 'utilization':
      return percent(figures.billed / figures.available * 100);
    case 'cost-ratio':
      return `${100 - figures.costRate}%`;
    case 'markup-on-cost': {
      const billing = figures.cost * (100 + figures.markup) / 100;
      return percent((billing - figures.cost) / billing * 100);
    }
    case 'contribution-arithmetic':
      return euros(figures.gross - figures.overhead);
    case 'portfolio-gm-percent':
      return percent(figures.gross / figures.revenue * 100);
    case 'portfolio-contribution-euro':
      return euros(figures.gross - figures.overhead);
    case 'bench':
      return euros(figures.gross - figures.benchBilling);
    case 'overhead-gm':
      return euros(figures.gross);
    case 'rate-cut': {
      const before = figures.billing - figures.cost;
      return `It changes from ${euros(before)} to ${euros(before - figures.billing * figures.reduction / 100)}.`;
    }
    case 'consultant-compare':
      return (figures.billingA - figures.costA) / figures.billingA > (figures.billingB - figures.costB) / figures.billingB
        ? 'Consultant A' : 'Consultant B';
    case 'bm-compare':
      return figures.grossA / figures.revenueA > figures.grossB / figures.revenueB ? 'BM Alpha' : 'BM Beta';
    case 'cost-mix-scale':
    case 'cost-mix-faster': {
      const before = percent((figures.revenue - figures.cost) / figures.revenue * 100);
      const after = percent((figures.nextRevenue - figures.nextCost) / figures.nextRevenue * 100);
      return figures.kind === 'cost-mix-scale' ? `It stays at ${before}` : `It falls from ${before} to ${after}`;
    }
    case 'canonical-ratio':
      return percent(figures.numerator / figures.denominator * 100);
    case 'canonical-euro':
      return euros(figures.amount);
    case 'canonical-bench':
      return euros(figures.gross - figures.billing);
    case 'canonical-overhead-gm':
      return euros(figures.gross);
    case 'canonical-overhead-contribution':
      return euros(figures.contribution - figures.delta);
    case 'margin-drop':
      return 'Direct costs increased (e.g., salary raises or higher-cost profiles placed at the same billing rate)';
    default:
      throw new Error(`No independent check for ${figures.kind}`);
  }
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

test('the server bank has at least 200 items and each hiring paper draws a different set of 15', () => {
  const bank = questionBank();
  assert.ok(bank.length >= 200, `bank has ${bank.length} items`);
  assert.equal(new Set(bank.map(item => item.bankId)).size, bank.length);
  assert.equal(new Set(bank.map(item => item.prompt)).size, bank.length);
  const papers = Array.from({ length: 30 }, () => makePaper());
  const signatures = new Set();
  const seen = new Map();
  for (const paper of papers) {
    assert.equal(paper.questions.length, 15);
    assert.deepEqual(paper.questions.map(question => question.section), [
      ...Array(8).fill('Foundations'), ...Array(7).fill('Applied Reading'),
    ]);
    assert.equal(new Set(paper.bankIds).size, 15);
    signatures.add([...paper.bankIds].sort().join('|'));
    for (const id of paper.bankIds) seen.set(id, (seen.get(id) ?? 0) + 1);
    assert.equal(grade(paper, paper.key), 15);
    assert.equal(JSON.stringify(paper.questions).includes('Good answer:'), false);
    assert.equal(JSON.stringify(paper.questions).includes('"bankIds"'), false);
    assert.equal(JSON.stringify(paper.questions).includes('"explanation"'), false);
    for (const question of paper.questions) {
      assert.equal(question.options.length, 4);
      assert.equal(new Set(question.options.map(option => option.text)).size, 4);
      assert.equal(Object.hasOwn(question, 'usesReferenceTable'), false);
      for (const option of question.options) assert.deepEqual(Object.keys(option).sort(), ['id', 'text']);
    }
    assert.deepEqual(Object.keys(paper.notes).sort(), paper.questions.map(question => question.id).sort());
    for (const question of paper.questions) {
      assert.match(paper.notes[question.id], new RegExp(`^Good answer: ${correctText(paper, question).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Why the others are not:`));
    }
  }
  assert.equal(signatures.size, papers.length, 'hiring draws are not a repeated set');
  assert.ok([...seen.values()].every(count => count < papers.length), 'no hiring item is pinned to every paper');
  assert.ok(seen.size > 40, 'rotation uses more than one fixed paper of items');
});

test('every bank item is internally solved and issued papers copy that item without the key', () => {
  const bank = questionBank();
  const byId = new Map(bank.map(item => [item.bankId, item]));
  let lowerBillingWins = 0;
  let higherBillingWins = 0;
  let lowerRevenueWins = 0;
  let higherRevenueWins = 0;
  for (const item of bank) {
    assert.equal(new Set([item.correct, ...item.alternatives]).size, 4, item.bankId);
    assert.match(item.explanation, /^Good answer: .+\. Why the others are not: .{20,}/s);
    if (item.figures) assert.equal(item.correct, expectedFromFigures(item.figures), item.bankId);
    if (item.figures?.kind === 'margin-drop') assert.ok(item.figures.currentMargin < item.figures.previousMargin);
    if (item.figures?.kind === 'bench' || item.figures?.kind === 'canonical-bench') {
      const billing = item.figures.benchBilling ?? item.figures.billing;
      const payroll = item.figures.benchPayroll ?? item.figures.payroll;
      assert.ok(item.figures.gross > billing);
      if (item.figures.directCosts !== undefined) assert.ok(item.figures.directCosts > payroll);
    }
    if (item.figures?.kind === 'portfolio-gm-percent' || item.figures?.kind === 'portfolio-contribution-euro' || item.figures?.kind === 'bench' || item.figures?.kind === 'overhead-gm') {
      assert.equal(item.figures.directCosts + item.figures.gross, item.figures.revenue);
      assert.equal(item.figures.contribution, item.figures.gross - item.figures.overhead);
      assert.ok(item.table);
    }
    if (item.figures?.kind === 'cost-mix-scale' || item.figures?.kind === 'cost-mix-faster') {
      assert.equal(item.figures.cost, item.figures.revenue * item.figures.costRate / 100);
      assert.equal(item.figures.nextRevenue, Math.round(item.figures.revenue * (100 + item.figures.revenueGrowth) / 100));
      assert.equal(item.figures.nextCost, Math.round(item.figures.cost * (100 + item.figures.costGrowth) / 100));
      const before = (item.figures.revenue - item.figures.cost) / item.figures.revenue;
      const after = (item.figures.nextRevenue - item.figures.nextCost) / item.figures.nextRevenue;
      if (item.figures.kind === 'cost-mix-scale') assert.equal(percent(before * 100), percent(after * 100));
      else assert.ok(after < before);
    }
    if (item.figures?.kind === 'consultant-compare') {
      const rateA = (item.figures.billingA - item.figures.costA) / item.figures.billingA;
      const rateB = (item.figures.billingB - item.figures.costB) / item.figures.billingB;
      const lowerBillingWinsRound = (item.figures.billingA < item.figures.billingB) === (rateA > rateB);
      if (item.figures.billingA !== item.figures.billingB) {
        if (lowerBillingWinsRound) lowerBillingWins++;
        else higherBillingWins++;
      }
      assert.ok([item.correct, ...item.alternatives].every(choice => !/%/.test(choice)));
    }
    if (item.figures?.kind === 'bm-compare') {
      const rateA = item.figures.grossA / item.figures.revenueA;
      const rateB = item.figures.grossB / item.figures.revenueB;
      const lowerRevenueWinsRound = (item.figures.revenueA < item.figures.revenueB) === (rateA > rateB);
      if (item.figures.revenueA !== item.figures.revenueB) {
        if (lowerRevenueWinsRound) lowerRevenueWins++;
        else higherRevenueWins++;
      }
      assert.ok([item.correct, ...item.alternatives].every(choice => !/%/.test(choice)));
    }
    if (item.pool === 'practice') assert.equal(item.usesReferenceTable, true);
    if (item.usesReferenceTable) assert.equal(item.pool, 'practice');
  }
  assert.ok(lowerBillingWins > 0 && higherBillingWins > 0, 'consultant comparison is not a billing-size shortcut');
  assert.ok(lowerRevenueWins > 0 && higherRevenueWins > 0, 'portfolio comparison is not a revenue-size shortcut');

  const catalog = new Map(bank.map(item => [item.prompt, item]));
  const originals = [
    ['What does P&L stand for?', 'Profit & Loss'],
    ['At Amaris, Revenue is primarily generated by:', "Billing consultants' services to clients at an agreed daily or monthly rate"],
    ['In consulting, Gross Margin is best defined as:', 'Revenue from client billing minus the direct cost of the consultants (salaries + charges)'],
    ['As a Business Manager at Amaris, which of the following is considered a direct cost on your P&L?', 'The salary and social charges of your billable consultants'],
    ['One of your consultants is on the bench (not currently billed to any client) for a full month. Their salary is still being paid. What is the direct impact on your Gross Margin?', 'Gross Margin decreases, as you bear the cost without generating revenue from this consultant'],
    ['As a Business Manager, which of the following actions has the most direct positive impact on your Gross Margin?', 'Placing a bench consultant quickly at a billing rate above their cost'],
  ];
  for (const [prompt, correct] of originals) assert.equal(catalog.get(prompt).correct, correct);

  for (const paper of [makePaper(), drawPracticePaper()]) {
    assert.equal(paper.questions.length, 15);
    paper.questions.forEach((question, index) => {
      const item = byId.get(paper.bankIds[index]);
      assert.equal(question.prompt, item.prompt);
      assert.equal(correctText(paper, question), item.correct);
      assert.deepEqual(new Set(question.options.map(option => option.text)), new Set([item.correct, ...item.alternatives]));
      assert.equal(Object.hasOwn(question, 'explanation'), false);
    });
  }
});

test('client questions keep prompts and choices and drop the grading material', () => {
  const leaked = clientQuestion({
    id: 'issued',
    section: 'Foundations',
    prompt: 'What does P&L stand for?',
    options: [{ id: 'a', text: 'Profit & Loss', correct: true }],
    explanation: 'Good answer: Profit & Loss. Why the others are not: they are other names.',
    bankId: 'pnl-name-0',
    notes: 'hidden',
  });
  assert.deepEqual(leaked, {
    id: 'issued',
    section: 'Foundations',
    prompt: 'What does P&L stand for?',
    options: [{ id: 'a', text: 'Profit & Loss' }],
  });
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
  assert.equal(money('€1,300'), 1300);
});

test('both sections and option positions are randomized without changing issued grading', () => {
  const papers = Array.from({ length: 40 }, () => makePaper());
  const signatures = papers.map(paper => [...paper.bankIds].sort().join('|'));
  assert.equal(new Set(signatures).size, papers.length);
  const placements = papers.flatMap(paper => paper.questions.map(question => question.options.findIndex(option => option.id === paper.key[question.id][0])));
  assert.equal(new Set(placements).size, 4);
  for (const paper of papers) assert.equal(grade(paper, paper.key), 15);
});
