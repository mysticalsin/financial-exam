// This module and each paper's grading key belong in the Worker only.
import { HIRING_BANK } from './hiring-bank.js';

export { HIRING_BANK };

const euroFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const euros = value => '€' + euroFormatter.format(value);
const FOUNDATION_DRAW = 8;
const APPLIED_DRAW = 7;

function indexBelow(limit) {
  const range = 0x100000000;
  const cutoff = range - range % limit;
  const word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= cutoff);
  return word[0] % limit;
}

function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = indexBelow(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function table(headers, rows) { return { headers, rows }; }

export function makePortfolioCase(revenue, marginRate, overhead) {
  if (!Number.isInteger(revenue) || revenue < 90000 || revenue > 300000 || revenue % 100 !== 0 ||
      !Number.isInteger(marginRate) || marginRate < 28 || marginRate > 46) {
    throw new Error('Portfolio figures are outside the supported range.');
  }
  const gross = revenue * marginRate / 100;
  const directCosts = revenue - gross;
  const minimumOverhead = Math.ceil(revenue * 0.08 / 10) * 10;
  const maximumOverhead = Math.floor(Math.min(revenue * 0.24, gross - 1000) / 10) * 10;
  if (!Number.isInteger(overhead) || overhead < minimumOverhead || overhead > maximumOverhead || overhead % 10 !== 0)
    throw new Error('Portfolio overhead is outside the supported range.');
  return {
    revenue, marginRate, directCosts, gross, overhead,
    contribution: gross - overhead,
    table: table(['Line Item', 'Amount (€)'], [
      ['Revenue (client billing)', euros(revenue)],
      ['Direct Costs (consultant salaries + charges)', euros(directCosts)],
      ['Gross Margin', euros(gross)],
      ['Allocated Overhead (office, support functions)', euros(overhead)],
      ['Operating Result (Contribution)', euros(gross - overhead)]
    ])
  };
}

function draw(section, count) {
  const pool = HIRING_BANK.filter(question => question.section === section);
  if (pool.length < count) throw new Error('The ' + section + ' bank is shorter than a paper.');
  return shuffle(pool).slice(0, count);
}

export function makePaper() {
  const selected = [...draw('Foundations', FOUNDATION_DRAW), ...draw('Applied Reading', APPLIED_DRAW)];
  const questions = [];
  const key = {};
  const explanations = {};
  for (const entry of selected) {
    const id = crypto.randomUUID();
    const options = shuffle([entry.correct, ...entry.alternatives].map(text => ({ id: crypto.randomUUID(), text })));
    key[id] = [options.find(option => option.text === entry.correct).id];
    explanations[id] = { good: entry.explanations.good, bad: entry.explanations.bad };
    const question = { id, section: entry.section, prompt: entry.prompt, options };
    if (entry.table) question.table = { headers: [...entry.table.headers], rows: entry.table.rows.map(row => [...row]) };
    questions.push(question);
  }
  return { questions, key, explanations };
}

export function reviewPaper(paper, answers) {
  return paper.questions.map(question => {
    const selected = answers?.[question.id];
    const answered = Array.isArray(selected) && selected.length > 0;
    const good = answered && selected.length === 1 && selected[0] === paper.key[question.id]?.[0];
    const pair = paper.explanations?.[question.id];
    if (!pair?.good || !pair?.bad) throw new Error('The issued paper is missing an explanation.');
    return {
      id: question.id,
      prompt: question.prompt,
      outcome: good ? 'good' : answered ? 'bad' : 'unanswered',
      explanation: good ? pair.good : pair.bad,
    };
  });
}

export function grade(paper, answers) {
  let score = 0;
  for (const { id } of paper.questions) {
    const selected = answers?.[id];
    if (Array.isArray(selected) && selected.length === 1 && selected[0] === paper.key[id][0]) score++;
  }
  return score;
}
