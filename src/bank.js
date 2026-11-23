// This module and each paper's grading key belong in the Worker only.
// A candidate receives the issued prompts, choices, and tables. The undrawn bank,
// correct answers, and end-of-paper explanations stay here.
const euroFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const euros = value => '€' + euroFormatter.format(value);
const percent = value => Number(value.toFixed(1)) + '%';

export const FOUNDATION_SLOTS = 8;
export const APPLIED_SLOTS = 7;
export const PAPER_SIZE = FOUNDATION_SLOTS + APPLIED_SLOTS;
export const BANK_MINIMUM = 200;

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

function item(prompt, correct, ...alternatives) {
  const choices = [correct, ...alternatives];
  if (choices.length !== 4 || new Set(choices).size !== 4) throw new Error('Each question must have four distinct choices.');
  return { prompt, correct, alternatives };
}

// End-of-paper teaching text. It is stored beside the key and is not copied onto the issued question.
function explained(entry, because) {
  if (typeof because !== 'string' || because.trim().length < 20) throw new Error('Each question must explain the other answers.');
  return { ...entry, explanation: `Good answer: ${entry.correct}. Why the others are not: ${because.trim()}` };
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

function samplePortfolio(revenue, marginRate, index) {
  const share = [0.10, 0.12, 0.14, 0.18, 0.20, 0.22][index % 6];
  const gross = revenue * marginRate / 100;
  const minimumOverhead = Math.ceil(revenue * 0.08 / 10) * 10;
  const maximumOverhead = Math.floor(Math.min(revenue * 0.24, gross - 1000) / 10) * 10;
  let overhead = Math.round(revenue * share / 10) * 10;
  if (overhead < minimumOverhead) overhead = minimumOverhead;
  if (overhead > maximumOverhead) overhead = maximumOverhead;
  return makePortfolioCase(revenue, marginRate, overhead);
}

function fillChoices(correct, preferred) {
  const alternatives = [];
  const seen = new Set([correct]);
  for (const candidate of [...preferred, '100%', '0%', '12.5%', '87.5%', '50%']) {
    if (typeof candidate !== 'string' || seen.has(candidate)) continue;
    seen.add(candidate);
    alternatives.push(candidate);
    if (alternatives.length === 3) return alternatives;
  }
  throw new Error(`Could not build choices around ${correct}.`);
}

const referenceTable = {
  title: "Reference P&L — Business Manager's Monthly Portfolio",
  headers: ['Line Item', 'Amount (€)'],
  rows: [
    ['Revenue (client billing)', '€120,000'],
    ['Direct Costs (consultant salaries + charges)', '€78,000'],
    ['Gross Margin', '€42,000'],
    ['Allocated Overhead (office, support functions)', '€18,000'],
    ['Operating Result (Contribution)', '€24,000'],
  ],
};

const CANONICAL = { revenue: 120000, direct: 78000, gross: 42000, overhead: 18000, contribution: 24000 };

const BANK = [];

function addItem(entry) {
  const bankId = `${entry.topic}-${BANK.filter(item => item.topic === entry.topic).length}`;
  const choices = [entry.correct, ...entry.alternatives];
  if (choices.length !== 4 || new Set(choices).size !== 4) throw new Error(`Choices collide for ${bankId}`);
  if (!entry.explanation?.startsWith(`Good answer: ${entry.correct}. Why the others are not:`)) {
    throw new Error(`Missing explanation for ${bankId}`);
  }
  BANK.push({
    bankId,
    topic: entry.topic,
    section: entry.section,
    pool: entry.pool,
    prompt: entry.prompt,
    correct: entry.correct,
    alternatives: entry.alternatives,
    explanation: entry.explanation,
    table: entry.table,
    usesReferenceTable: entry.usesReferenceTable === true,
    figures: entry.figures ?? null,
  });
}

function concept(topic, section, prompt, correct, alternatives, because, extra = {}) {
  const built = explained(item(prompt, correct, ...alternatives), because);
  addItem({
    topic,
    section,
    pool: extra.pool ?? 'both',
    prompt: built.prompt,
    correct: built.correct,
    alternatives: built.alternatives,
    explanation: built.explanation,
    table: extra.table,
    usesReferenceTable: extra.usesReferenceTable === true,
    figures: extra.figures ?? null,
  });
}

function seeded(topic, section, prompt, correct, alternatives, because, extra = {}) {
  const built = explained(item(prompt, correct, ...alternatives), because);
  addItem({
    topic, section, pool: extra.pool ?? 'both', prompt, ...built,
    table: extra.table, usesReferenceTable: extra.usesReferenceTable === true, figures: extra.figures ?? null,
  });
}

const foundations = [
  ['pnl-name', 'What does P&L stand for?', 'Profit & Loss', ['Planning & Logistics', 'Profit & Liquidity', 'Performance & Leverage'],
    'Planning & Logistics, Profit & Liquidity, and Performance & Leverage are not the name of the profit and loss statement.'],
  ['pnl-name', 'Which financial statement shows revenue, costs, and profit over a period?', 'The profit and loss statement', ['The balance sheet', 'A capitalization table', 'An organisation chart'],
    'A balance sheet is a snapshot of assets and liabilities. A capitalization table tracks ownership. An organisation chart shows reporting lines.'],
  ['pnl-name', 'On which statement does a Business Manager read Gross Margin?', 'The profit and loss statement', ['The fixed-asset register', 'The shareholder register', 'The office seating plan'],
    'Gross margin is revenue minus direct cost for a period. The other lists are not performance statements.'],
  ['pnl-name', 'What does a P&L measure?', 'Performance over a period, including revenue and costs', ['Only the cash in the bank on one morning', 'The ownership split among shareholders', 'The number of laptops in the office'],
    'A single cash balance, a cap table, and an asset count do not report profit for a period.'],
  ['revenue-source', 'At Amaris, Revenue is primarily generated by:', "Billing consultants' services to clients at an agreed daily or monthly rate", ['The number of consultants hired', 'The number of contracts signed per year', 'The overhead charged to support functions'],
    'Headcount, the number of contracts, and overhead charged to support functions do not themselves create client revenue.'],
  ['revenue-source', 'When is consulting revenue recognized in this operating model?', "When a consultant's work is billed to a client at the agreed rate", ['When a candidate accepts an offer', 'When a framework is signed and no days are billed', 'When overhead is allocated to the team'],
    'Hiring, a contract with nothing billed, and an overhead allocation do not themselves create client revenue.'],
  ['revenue-source', 'Which of the following increases Revenue on the P&L?', 'Billing additional client days at the agreed rate', ['Hiring a consultant who is not yet billed', 'Cutting office rent', 'Collecting cash for revenue that was already recorded'],
    'An unbilled hire does not create revenue. Rent is overhead. Collecting cash for revenue already recorded does not record that revenue again.'],
  ['revenue-source', 'A contract allows up to 50 days and 10 days have been billed. What is revenue so far, in this model?', 'Only the 10 days actually billed', ['All 50 days on the signature date', 'Nothing until the contract ends', "The Business Manager's overhead budget"],
    'The unused maximum has not been billed. Waiting until the end ignores days already billed. Overhead is not client revenue.'],
  ['gm-definition', 'In consulting, Gross Margin is best defined as:', 'Revenue from client billing minus the direct cost of the consultants (salaries + charges)', ['Total revenue before any deductions', 'Revenue minus all company overhead and administrative costs', 'Net income after taxes'],
    'Total revenue before deductions is revenue, not margin. Subtracting all overhead describes a result after indirect costs. Net income after taxes comes after every cost and tax.'],
  ['gm-definition', 'Which formula matches Gross Margin in this assessment?', 'Client revenue minus direct consultant costs', ['Client revenue minus every company cost, including tax', 'Direct consultant costs minus client revenue', 'Overhead minus client revenue'],
    'Subtracting tax and every other cost is a later profit measure. Reversing the subtraction, or starting from overhead, is not gross margin.'],
  ['gm-definition', 'Gross Margin is struck before which of these?', 'Allocated overhead, interest, and tax', ['The direct cost of billable consultants', 'Client billing', 'Nothing; it is the same figure as cash in the bank'],
    'Direct cost is deducted to reach gross margin, and client billing is the revenue you start from. Cash in the bank is not gross margin.'],
  ['gm-definition', 'Which cost is deducted when moving from Revenue to Gross Margin?', 'Direct cost of the consultants who deliver the billed work', ['Corporate income tax', 'Allocated head-office rent', 'Dividends paid to shareholders'],
    'Tax, allocated rent, and dividends sit outside the gross margin used here.'],
  ['gm-definition', 'How does Gross Margin differ from net income?', 'Gross margin stops after direct delivery cost; net income is after overhead, financing, and tax', ['They are two names for the same figure', 'Net income is calculated before revenue', 'Gross margin is struck after dividends'],
    'The names are not interchangeable. Net income is not struck before revenue, and gross margin is not struck after dividends.'],
  ['direct-cost-id', 'As a Business Manager at Amaris, which of the following is considered a direct cost on your P&L?', 'The salary and social charges of your billable consultants', ['The rent of the Amaris head office', 'The marketing budget of the Amaris brand', "The CEO's compensation"],
    "Head-office rent, brand marketing, and the CEO's compensation are overhead, not the direct cost of billable consultants."],
  ['direct-cost-id', 'Which cost is a direct cost of billable work?', 'Salary and employer charges of a consultant staffed on a client', ['Rent of the head office', 'A brand campaign for Amaris', "The CEO's compensation"],
    'Head-office rent, a brand campaign, and CEO compensation are not the cost of one billed consultant.'],
  ['direct-cost-id', "Employer social charges on a billable consultant's salary are:", "Part of that consultant's direct cost", ['Always overhead, because they are statutory', 'A reduction of client revenue', 'A dividend'],
    'Statutory charges on a billable salary still travel with that salary into direct cost. They do not reduce the client invoice, and they are not a dividend.'],
  ['direct-cost-id', 'A freelancer is paid by the company and billed through to the client. That fee is:', 'A direct cost of the billed engagement', ['Overhead, because the person is not an employee', 'Revenue, because the client pays', 'A balance-sheet equity item'],
    'Not being an employee does not make the fee overhead when it is the cost of delivering billed work. The client payment is revenue, not the fee. The fee is not equity.'],
  ['direct-cost-id', 'Which of these stays out of direct cost?', 'The salary of an internal recruiter who is not billed to clients', ['The salary of a consultant billed five days a week', 'Employer charges on that billed consultant', 'A subcontractor invoice recharged on a client mission'],
    'The billed consultant, their employer charges, and a recharged subcontractor are delivery costs. An unbilled recruiter is a support cost.'],
  ['bench-impact', 'One of your consultants is on the bench (not currently billed to any client) for a full month. Their salary is still being paid. What is the direct impact on your Gross Margin?', 'Gross Margin decreases, as you bear the cost without generating revenue from this consultant', ['No impact, since the consultant is still employed', 'Gross Margin improves because there is no billing to manage', 'Gross Margin increases because the consultant is available'],
    'Employment alone does not keep the margin unchanged. Having nothing to bill does not improve it, and availability does not increase it.'],
  ['bench-impact', 'A consultant remains employed and unbilled for the month. What happens to revenue from that consultant?', 'It is zero for that month, because nothing was billed', ['It stays equal to their salary', 'It increases because they are available', "It equals last month's billing automatically"],
    'Salary is a cost, not revenue. Availability does not create a client invoice. Last month’s billing does not repeat by itself.'],
  ['bench-impact', 'Placing a benched consultant on a mission billed above their cost will:', 'Increase gross margin relative to leaving them unbilled', ['Leave gross margin unchanged because headcount is unchanged', 'Reduce gross margin because a new invoice creates work', 'Remove their salary from the accounts'],
    'Headcount alone does not fix the margin. An invoice above cost adds more revenue than cost. The salary does not disappear when the consultant is billed.'],
  ['bench-impact', 'Bench time with payroll still running affects Gross Margin % because:', 'Cost remains while revenue from that consultant does not', ['Overhead is reclassified as revenue', 'The client rate increases automatically', 'Tax falls by the same amount'],
    'Bench time does not turn overhead into revenue, does not raise the client rate, and is not a tax adjustment.'],
  ['bench-impact', 'Two of five consultants are unbilled and still paid. Compared with all five billed above cost, gross margin is:', 'Lower, because two costs have no matching revenue', ['Higher, because fewer invoices were issued', 'Unchanged, because the contracts still exist', 'Higher, because less billing means less cost'],
    'Fewer invoices are not a gain. An unbilled contract is not revenue. Less billing does not remove the payroll that is still being paid.'],
  ['overhead-vs-direct', 'Which of the following is overhead rather than a direct cost?', 'Rent of the head office', ['Salary of a consultant billed to a client', 'Employer charges on that billed salary', 'A subcontractor billed through to the client'],
    'The billed salary, its employer charges, and a recharged subcontractor are delivery costs. Head-office rent is overhead in this model.'],
  ['overhead-vs-direct', 'The marketing budget of the Amaris brand is:', 'Overhead, not a direct cost of a billed consultant', ['Direct cost, because it helps win clients', 'A deduction from client revenue', 'The gross margin'],
    'Winning work is not the cost of delivering billed days. Brand spend is not subtracted from a client invoice, and it is not gross margin.'],
  ['overhead-vs-direct', "The CEO's compensation is classified here as:", 'Overhead', ['Direct cost of every billed consultant', 'Client revenue', 'A negative direct cost'],
    'The CEO is not a billed delivery cost. That compensation is not revenue, and it is not a negative direct cost.'],
  ['overhead-vs-direct', 'Cutting allocated office rent improves which figure first?', 'Contribution (operating result), not gross margin', ['Gross margin, by the same amount', 'Client revenue', "The consultant's daily billing rate"],
    'Rent sits below gross margin. Cutting it does not change client revenue or the billing rate.'],
  ['overhead-vs-direct', 'A support-function salary that is never billed to a client is:', 'Overhead', ['Direct cost, because it is a salary', 'Revenue', 'Gross margin'],
    'Being a salary is not enough. Direct cost here is the cost of billed delivery. A support salary is not revenue or gross margin.'],
  ['contribution-definition', 'Operating result (contribution) equals:', 'Gross margin minus allocated overhead', ['Revenue minus overhead, ignoring direct cost', 'Direct cost minus overhead', 'Revenue plus gross margin'],
    'Ignoring direct cost, subtracting overhead from direct cost, or adding revenue to gross margin does not produce contribution.'],
  ['contribution-definition', 'Contribution can be negative while gross margin is positive when:', 'Allocated overhead is larger than gross margin', ['Revenue is larger than direct cost', 'A consultant is billed above cost', 'The billing rate increases'],
    'Revenue above direct cost is a positive gross margin, not a negative contribution. Billing above cost and a higher rate do not by themselves make contribution negative.'],
  ['contribution-definition', 'If gross margin is €40,000 and allocated overhead is €15,000, contribution is:', '€25,000', ['€40,000', '€15,000', '€55,000'],
    '€40,000 leaves the overhead in place. €15,000 is the overhead itself. €55,000 adds the overhead instead of subtracting it.',
    { figures: { kind: 'contribution-arithmetic', gross: 40000, overhead: 15000 } }],
  ['contribution-definition', 'Which statement about contribution is right?', 'It is struck after overhead; gross margin is struck before overhead', ['It is struck before direct cost', 'It ignores overhead', 'It is always equal to revenue'],
    'Contribution is not struck before direct cost, it does not ignore overhead, and it is not revenue.'],
];

for (const entry of foundations) {
  const [topic, prompt, correct, alternatives, because, extra] = entry;
  concept(topic, 'Foundations', prompt, correct, alternatives, because, extra);
}

const dailyPairs = [
  [600, 390], [650, 400], [700, 420], [750, 480], [800, 500], [850, 510],
  [900, 540], [950, 600], [1000, 620], [1100, 660], [1200, 780], [1300, 800],
  [1400, 910], [1500, 900], [1600, 1040], [1800, 1080], [2000, 1250], [2400, 1500],
];

for (const [billing, cost] of dailyPairs) {
  const gross = billing - cost;
  if (gross <= 0 || gross === cost || gross === billing) throw new Error(`Daily pair ${billing}/${cost} is not usable.`);
  const correct = euros(gross);
  const alternatives = [euros(billing + cost), euros(billing), euros(cost)];
  seeded('daily-euro', 'Foundations',
    `A consultant is billed to a client at ${euros(billing)}/day. Their internal daily cost (salary + employer charges) is ${euros(cost)}/day. What is the Gross Margin per day?`,
    correct, alternatives,
    `${euros(billing + cost)} adds billing and cost. ${euros(billing)} is the billing rate alone, and ${euros(cost)} is the cost alone.`,
    { figures: { kind: 'daily-euro', billing, cost } });

  const margin = percent(gross / billing * 100);
  const costShare = percent(cost / billing * 100);
  const onCost = percent(gross / cost * 100);
  const percentChoices = [margin, costShare, onCost, '100%'];
  if (new Set(percentChoices).size !== 4) throw new Error(`Daily percent collided for ${billing}/${cost}.`);
  seeded('daily-percent', 'Foundations',
    `A consultant bills ${euros(billing)} per day and costs ${euros(cost)} per day. What is the Gross Margin %?`,
    margin, [costShare, onCost, '100%'],
    `${costShare} is cost divided by billing. ${onCost} divides the margin by cost instead of billing. 100% would mean the consultant had no cost.`,
    { figures: { kind: 'daily-percent', billing, cost } });
}

const teamCases = [
  [3, 8000, 60], [3, 10000, 70], [3, 12000, 65], [4, 8000, 70],
  [4, 10000, 60], [4, 11000, 75], [5, 9000, 60], [5, 12000, 70],
  [6, 8000, 65], [6, 10000, 60], [4, 14000, 70], [5, 8000, 75],
  [4, 9000, 60], [6, 7000, 70],
];

for (const [headcount, billingPerConsultant, costRate] of teamCases) {
  const revenue = headcount * billingPerConsultant;
  const directCosts = revenue * costRate / 100;
  if (!Number.isInteger(directCosts)) throw new Error(`Team case ${headcount}/${billingPerConsultant}/${costRate} is not integral.`);
  const gross = revenue - directCosts;
  const correct = euros(gross);
  const alternatives = [euros(directCosts), euros(revenue), euros(revenue + directCosts)];
  if (new Set([correct, ...alternatives]).size !== 4) throw new Error(`Team euro collided for ${headcount}.`);
  seeded('team-euro', 'Foundations',
    `You manage a team of ${headcount} consultants, each billed at ${euros(billingPerConsultant)}/month to clients. The total monthly direct cost of the team is ${euros(directCosts)}. What is your team's monthly Gross Margin?`,
    correct, alternatives,
    `${euros(directCosts)} is the direct cost, ${euros(revenue)} is the revenue, and ${euros(revenue + directCosts)} adds those two figures.`,
    { figures: { kind: 'team-euro', headcount, billingPerConsultant, directCosts } });

  const margin = percent(gross / revenue * 100);
  const costShare = percent(costRate);
  const onCost = percent(gross / directCosts * 100);
  if (new Set([margin, costShare, onCost, '100%']).size !== 4) throw new Error(`Team percent collided for ${headcount}/${billingPerConsultant}.`);
  seeded('team-percent', 'Foundations',
    `A team of ${headcount} consultants bills ${euros(revenue)} in a month and has direct costs of ${euros(directCosts)}. What is the team's Gross Margin %?`,
    margin, [costShare, onCost, '100%'],
    `${costShare} is direct cost divided by revenue. ${onCost} divides the margin by direct cost. 100% would mean the team had no direct cost.`,
    { figures: { kind: 'team-percent', headcount, billingPerConsultant, directCosts, revenue } });
}

const utilizationCases = [
  [20, 16], [20, 15], [20, 10], [20, 18], [22, 11], [18, 12],
  [21, 14], [16, 12], [24, 18], [25, 20], [22, 16], [19, 19],
];

for (const [available, billed] of utilizationCases) {
  const rate = percent(billed / available * 100);
  const inverted = percent(available / billed * 100);
  const alternatives = [];
  const seen = new Set([rate]);
  for (const candidate of [`${billed}%`, `${available}%`, inverted === rate ? '50%' : inverted, '0%', '25%']) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    alternatives.push(candidate);
    if (alternatives.length === 3) break;
  }
  if (alternatives.length !== 3) throw new Error(`Utilization collided for ${billed}/${available}.`);
  seeded('utilization', 'Foundations',
    `A consultant is available for ${available} working days in the month and is billed to clients for ${billed} of them. What is the utilization rate?`,
    rate, alternatives,
    `${alternatives[0]}, ${alternatives[1]}, and ${alternatives[2]} do not equal billed days divided by available days.`,
    { figures: { kind: 'utilization', available, billed } });
}

const costRatios = [60, 70, 55, 80, 65, 75, 62, 58, 68, 72];
for (const costRate of costRatios) {
  const margin = 100 - costRate;
  const correct = `${margin}%`;
  const alternatives = [`${costRate}%`, '100%', `${Math.max(margin - 15, 5)}%`];
  if (new Set([correct, ...alternatives]).size !== 4) throw new Error(`Cost ratio collided at ${costRate}.`);
  seeded('markup-vs-margin', 'Foundations',
    `Direct costs are ${costRate}% of revenue. What is the Gross Margin %?`,
    correct, alternatives,
    `${costRate}% is the direct-cost share, not the margin. 100% would mean there was no direct cost. ${alternatives[2]} is not revenue minus that direct-cost share.`,
    { figures: { kind: 'cost-ratio', costRate } });
}

const markups = [[100, 25], [400, 50], [200, 25], [800, 60], [500, 25], [1000, 40]];
for (const [cost, markup] of markups) {
  const billing = cost * (100 + markup) / 100;
  if (!Number.isInteger(billing)) throw new Error(`Markup ${cost}/${markup} is not integral.`);
  const correct = percent((billing - cost) / billing * 100);
  const alternatives = [`${markup}%`, percent(cost / billing * 100), percent(billing / cost * 100)];
  if (new Set([correct, ...alternatives]).size !== 4) throw new Error(`Markup collided for ${cost}/${markup}.`);
  seeded('markup-vs-margin', 'Foundations',
    `A consultant costs ${euros(cost)} and is billed at a ${markup}% markup on cost. What is the Gross Margin %?`,
    correct, alternatives,
    `${markup}% is the markup on cost, not the margin on billing. ${alternatives[1]} is cost divided by billing. ${alternatives[2]} is billing divided by cost.`,
    { figures: { kind: 'markup-on-cost', cost, markup } });
}

const portfolioSeeds = [
  [95000, 32], [110000, 36], [125000, 30], [140000, 38], [160000, 34],
  [175000, 40], [190000, 28], [210000, 42], [240000, 33], [280000, 37],
];
const benchPairs = [[8000, 5000], [9000, 6500], [10000, 7000], [12000, 8000], [14000, 9000], [16000, 10000]];

portfolioSeeds.forEach((seed, index) => {
  const portfolio = samplePortfolio(seed[0], seed[1], index);
  const gm = percent(portfolio.gross / portfolio.revenue * 100);
  const costShare = percent(portfolio.directCosts / portfolio.revenue * 100);
  const contributionShare = percent(portfolio.contribution / portfolio.revenue * 100);
  const overheadShare = percent(portfolio.overhead / portfolio.revenue * 100);
  const gmAlternatives = fillChoices(gm, [costShare, contributionShare, overheadShare]);
  seeded('portfolio-gm-percent', 'Applied Reading',
    `This monthly portfolio bills ${euros(portfolio.revenue)}. What is the Gross Margin %?`,
    gm, gmAlternatives,
    `${gmAlternatives.join(', ')} are not gross margin over revenue (${euros(portfolio.gross)} / ${euros(portfolio.revenue)}).`,
    { table: portfolio.table, figures: { kind: 'portfolio-gm-percent', ...portfolio } });

  const resultAlternatives = fillChoices(euros(portfolio.contribution), [euros(portfolio.gross), euros(portfolio.overhead), euros(portfolio.directCosts), euros(portfolio.revenue)]);
  seeded('portfolio-result', 'Applied Reading',
    `Using the monthly portfolio that bills ${euros(portfolio.revenue)}, what is the operating result (contribution)?`,
    euros(portfolio.contribution), resultAlternatives,
    `${resultAlternatives.join(', ')} are not contribution. Contribution is gross margin minus overhead (${euros(portfolio.gross)} minus ${euros(portfolio.overhead)}).`,
    { table: portfolio.table, figures: { kind: 'portfolio-contribution-euro', ...portfolio } });

  const [benchBilling, benchPayroll] = benchPairs[index % benchPairs.length];
  if (portfolio.revenue <= benchBilling || portfolio.directCosts <= benchPayroll) throw new Error(`Bench case does not fit ${portfolio.revenue}.`);
  const nextMargin = euros(portfolio.gross - benchBilling);
  const benchAlternatives = [euros(portfolio.gross), euros(portfolio.gross - benchPayroll), euros(portfolio.gross - benchBilling + benchPayroll)];
  seeded('bench-numeric', 'Applied Reading',
    `One consultant (monthly cost: ${euros(benchPayroll)}; billing: ${euros(benchBilling)}) is included in the monthly portfolio below, which bills ${euros(portfolio.revenue)}. The consultant goes on the bench for a full month and their payroll remains in direct costs. What is the new Gross Margin for the month?`,
    nextMargin, benchAlternatives,
    `${euros(portfolio.gross)} ignores the lost billing. ${euros(portfolio.gross - benchPayroll)} subtracts payroll that is already inside direct costs. ${euros(portfolio.gross - benchBilling + benchPayroll)} treats that payroll as if it had left the costs. Only the lost ${euros(benchBilling)} of billing comes out of gross margin.`,
    { table: portfolio.table, figures: { kind: 'bench', benchBilling, benchPayroll, ...portfolio } });

  const delta = index % 2 === 0 ? 2000 : 4000;
  if (portfolio.contribution <= delta) throw new Error(`Overhead delta does not fit ${portfolio.revenue}.`);
  const unchanged = euros(portfolio.gross);
  const overheadAlternatives = [euros(portfolio.gross - delta), euros(portfolio.gross + delta), euros(portfolio.contribution - delta)];
  seeded('gm-unchanged', 'Applied Reading',
    `Allocated overhead on the ${euros(portfolio.revenue)} portfolio increases by ${euros(delta)}. Revenue and direct costs stay the same. What is the new Gross Margin?`,
    unchanged, overheadAlternatives,
    `${euros(portfolio.gross - delta)} and ${euros(portfolio.gross + delta)} move gross margin by the overhead change. ${euros(portfolio.contribution - delta)} is the new contribution, not gross margin. Overhead sits below gross margin.`,
    { table: portfolio.table, figures: { kind: 'overhead-gm', delta, ...portfolio } });
});

const marginDrops = [
  [38, 30], [42, 36], [44, 34], [40, 32], [46, 36], [36, 28],
];
for (const [previousMargin, currentMargin] of marginDrops) {
  seeded('margin-drop', 'Applied Reading',
    `Your Gross Margin % has dropped from ${percent(previousMargin)} to ${percent(currentMargin)} over the last quarter while revenue remained stable. Which is the most likely cause?`,
    'Direct costs increased (e.g., salary raises or higher-cost profiles placed at the same billing rate)',
    ['Overhead costs increased', 'You hired additional support staff', 'Taxes on the entity increased'],
    'Higher overhead, extra support staff, and taxes sit below gross margin. With revenue unchanged, a lower gross margin means direct cost rose.',
    { figures: { kind: 'margin-drop', previousMargin, currentMargin } });
}

concept('margin-drop', 'Applied Reading',
  'Revenue fell because two consultants were on the bench, while direct cost for the remaining billed work was unchanged. Gross margin % fell. Which explanation fits?',
  'Lost billing while payroll continued increased cost relative to revenue',
  ['Overhead increased and gross margin must follow it', 'The corporate tax rate increased', 'Client revenue rose faster than direct cost'],
  'Overhead and tax sit below gross margin. Revenue did not rise; billed work was lost while payroll continued.');

concept('margin-drop', 'Applied Reading',
  'Overhead increased. Revenue and direct costs were unchanged. What happens to Gross Margin %?',
  'It stays the same',
  ['It falls by the overhead increase', 'It rises because overhead is recovered in the margin', 'It falls because contribution fell'],
  'An overhead increase can reduce contribution. It does not change gross margin when revenue and direct costs are unchanged.');

const consultantPairs = [
  [8000, 5500, 12000, 9000],
  [9000, 5400, 14000, 9800],
  [10000, 6000, 15000, 10500],
  [11000, 7700, 13000, 7800],
  [8000, 4800, 16000, 11200],
  [12000, 6600, 12000, 8400],
  [7000, 4200, 18000, 12600],
  [10000, 7500, 9000, 5400],
  [14000, 7000, 8000, 4800],
  [16000, 11200, 11000, 6600],
];

consultantPairs.forEach(([billingA, costA, billingB, costB], index) => {
  const rateA = (billingA - costA) / billingA;
  const rateB = (billingB - costB) / billingB;
  if (rateA === rateB || costA >= billingA || costB >= billingB) throw new Error(`Consultant pair ${index} is not comparable.`);
  const winner = rateA > rateB ? 'Consultant A' : 'Consultant B';
  const loser = rateA > rateB ? 'Consultant B' : 'Consultant A';
  const names = ['Consultant A', 'Consultant B'];
  const prompt = index === 0
    ? 'You have two consultants in your portfolio. Which generates a better Gross Margin %?'
    : `You have two consultants in your portfolio, billed at ${euros(billingA)} and ${euros(billingB)} a month. Which generates a better Gross Margin %?`;
  seeded('consultant-compare', 'Applied Reading', prompt, winner, [loser, 'They are equal', 'Cannot be determined'],
    `${loser} earns a lower gross margin percentage than ${winner}. The rates differ, so they are not equal, and both can be calculated from billing and cost.`,
    {
      table: table(['', ...names], [
        ['Monthly Billing', euros(billingA), euros(billingB)],
        ['Monthly Cost', euros(costA), euros(costB)],
      ]),
      figures: { kind: 'consultant-compare', billingA, costA, billingB, costB },
    });
});

const managerPairs = [
  [300000, 90000, 500000, 120000],
  [200000, 70000, 450000, 135000],
  [300000, 120000, 300000, 90000],
  [250000, 100000, 400000, 120000],
  [500000, 150000, 200000, 80000],
  [180000, 72000, 360000, 108000],
  [220000, 66000, 280000, 112000],
  [600000, 240000, 150000, 45000],
  [320000, 80000, 320000, 128000],
  [150000, 60000, 700000, 210000],
];

managerPairs.forEach(([revenueA, grossA, revenueB, grossB], index) => {
  if (grossA >= revenueA || grossB >= revenueB) throw new Error(`Manager pair ${index} is outside the margin.`);
  const rateA = grossA / revenueA;
  const rateB = grossB / revenueB;
  if (rateA === rateB) throw new Error(`Manager pair ${index} is tied.`);
  const winner = rateA > rateB ? 'BM Alpha' : 'BM Beta';
  const loser = rateA > rateB ? 'BM Beta' : 'BM Alpha';
  const prompt = index === 0
    ? "You are comparing two Business Managers' portfolios at end of quarter. Which portfolio is more efficient from a Gross Margin % perspective?"
    : `You are comparing two Business Managers' portfolios, with revenue ${euros(revenueA)} and ${euros(revenueB)}. Which portfolio is more efficient from a Gross Margin % perspective?`;
  seeded('bm-compare', 'Applied Reading', prompt, winner,
    [loser, 'Both portfolios are equally efficient', 'There is not enough information to compare them'],
    `${loser} is at ${percent(rateA > rateB ? rateB * 100 : rateA * 100)}, below ${winner} at ${percent(rateA > rateB ? rateA * 100 : rateB * 100)}. A larger euro margin can still be a weaker percentage. The percentages differ, and the table is enough to compare them.`,
    {
      table: table(['', 'BM Alpha', 'BM Beta'], [
        ['Revenue', euros(revenueA), euros(revenueB)],
        ['Gross Margin', euros(grossA), euros(grossB)],
      ]),
      figures: { kind: 'bm-compare', revenueA, grossA, revenueB, grossB },
    });
});

const rateSeeds = [
  [10000, 65, 10], [8000, 60, 5], [12000, 65, 10], [14000, 60, 15],
  [16000, 70, 10], [18000, 60, 5], [9000, 70, 10], [20000, 70, 15],
  [11000, 60, 10], [15000, 60, 5], [13000, 70, 10], [17000, 60, 15],
];

for (const [billing, costRate, reduction] of rateSeeds) {
  const cost = billing * costRate / 100;
  const reductionValue = billing * reduction / 100;
  if (!Number.isInteger(cost) || !Number.isInteger(reductionValue)) throw new Error(`Rate case ${billing} is not integral.`);
  const before = billing - cost;
  const after = before - reductionValue;
  const correct = `It changes from ${euros(before)} to ${euros(after)}.`;
  const alternatives = [
    `It changes from ${euros(before)} to ${euros(before)}.`,
    `It changes from ${euros(before)} to ${euros(after - reductionValue)}.`,
    `It changes from ${euros(before)} to ${euros(billing - reductionValue)}.`,
  ];
  seeded('rate-reduction', 'Applied Reading',
    `A client asks you to reduce the billing rate by ${reduction}% for one consultant currently billed at ${euros(billing)}/month. The consultant's cost remains at ${euros(cost)}/month. What happens to the Gross Margin on this consultant?`,
    correct, alternatives,
    `Leaving the margin at ${euros(before)} ignores the ${euros(reductionValue)} price cut. ${euros(after - reductionValue)} subtracts that cut twice. ${euros(billing - reductionValue)} is the new billing, not the margin after the unchanged ${euros(cost)} cost.`,
    { figures: { kind: 'rate-cut', billing, cost, reduction } });
}

concept('best-action', 'Applied Reading',
  'As a Business Manager, which of the following actions has the most direct positive impact on your Gross Margin?',
  'Placing a bench consultant quickly at a billing rate above their cost',
  ['Reducing the number of internal meetings', 'Requesting a lower office space allocation', 'Hiring a new support profile in your team'],
  'Fewer internal meetings do not change gross margin. A smaller office allocation and a new support profile are overhead, not gross margin.');

concept('best-action', 'Applied Reading',
  "Which decision raises this month's Gross Margin?",
  'Start billing a bench consultant at a rate above their cost',
  ['Move the team to a cheaper office', 'Cut the brand advertising budget', 'Postpone a corporate tax payment'],
  'A cheaper office, a smaller advertising budget, and a later tax payment sit below gross margin.');

concept('best-action', 'Applied Reading',
  'Which item can increase Gross Margin rather than only the result after overhead?',
  'A higher client billing rate on the same direct cost',
  ["A lower office-rent allocation", 'A smaller marketing invoice', "A reduction in the CEO's bonus"],
  "Rent, marketing, and the CEO's bonus are overhead. A higher billing rate on the same direct cost raises gross margin.");

concept('best-action', 'Applied Reading',
  'What is the most direct way to improve a weak Gross Margin %?',
  'Reduce unbilled payroll or raise the price above cost',
  ['Spread the same overhead over a different cost-center label', 'Reclassify rent as a direct cost without changing the cash flows', 'Delay sending invoices without changing the work delivered'],
  'Relabeling overhead, reclassifying rent, and delaying an invoice do not change revenue minus direct cost.');

function addCostMix(kind, revenue, costRate, revenueGrowth, costGrowth) {
  const cost = revenue * costRate / 100;
  const nextRevenue = Math.round(revenue * (100 + revenueGrowth) / 100);
  const nextCost = Math.round(cost * (100 + costGrowth) / 100);
  const before = (revenue - cost) / revenue * 100;
  const after = (nextRevenue - nextCost) / nextRevenue * 100;
  const beforeText = percent(before);
  const afterText = percent(after);
  const prompt = `Revenue is ${euros(revenue)} and direct costs are ${euros(cost)}. Next month revenue is ${euros(nextRevenue)} and direct costs are ${euros(nextCost)}. What happens to the Gross Margin %?`;
  const figures = { kind, revenue, costRate, revenueGrowth, costGrowth, cost, nextRevenue, nextCost };
  if (kind === 'cost-mix-scale') {
    if (beforeText !== afterText) throw new Error(`Scaled mix moved the margin at ${revenue}.`);
    const up = percent(before + 10);
    const down = percent(before - 10);
    const other = costRate === (100 - costRate) ? '12.5%' : `${costRate}%`;
    seeded('cost-mix', 'Applied Reading', prompt, `It stays at ${beforeText}`, [`It rises to ${up}`, `It falls to ${down}`, `It becomes ${other}`],
      `${up} and ${down} move the margin even though revenue and direct cost grew at the same rate. ${other} is not the gross margin on these figures.`,
      { figures });
    return;
  }
  if (Number(afterText.slice(0, -1)) >= Number(beforeText.slice(0, -1))) throw new Error(`Faster cost did not cut the margin at ${revenue}.`);
  const up = percent(before + 4);
  const tooFar = percent(Math.max(after - 8, 1));
  seeded('cost-mix', 'Applied Reading', prompt, `It falls from ${beforeText} to ${afterText}`, [`It stays at ${beforeText}`, `It rises to ${up}`, `It falls to ${tooFar}`],
    `Staying at ${beforeText} ignores the faster cost growth. ${up} moves the margin the wrong way. ${tooFar} is a larger drop than ${euros(nextRevenue)} of revenue and ${euros(nextCost)} of direct cost produce.`,
    { figures });
}

addCostMix('cost-mix-scale', 100000, 60, 10, 10);
addCostMix('cost-mix-scale', 80000, 50, 10, 10);
addCostMix('cost-mix-scale', 200000, 70, 20, 20);
addCostMix('cost-mix-scale', 150000, 40, 10, 10);
addCostMix('cost-mix-faster', 100000, 60, 10, 20);
addCostMix('cost-mix-faster', 150000, 40, 10, 25);
addCostMix('cost-mix-faster', 120000, 55, 5, 15);
addCostMix('cost-mix-faster', 180000, 65, 10, 20);

function canonical(topic, prompt, correct, alternatives, because, figures) {
  concept(topic, 'Applied Reading', prompt, correct, alternatives, because, {
    pool: 'practice', usesReferenceTable: true, figures,
  });
}

canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what is the Gross Margin %?',
  '35%', ['65%', '20%', '15%'],
  '65% is direct cost over revenue. 20% is contribution over revenue. 15% is overhead over revenue. Gross margin is €42,000 / €120,000.',
  { kind: 'canonical-ratio', numerator: 42000, denominator: 120000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what is the operating result (contribution) as a percentage of revenue?',
  '20%', ['35%', '15%', '65%'],
  '35% is gross margin over revenue. 15% is overhead over revenue. 65% is direct cost over revenue. Contribution is €24,000 / €120,000.',
  { kind: 'canonical-ratio', numerator: 24000, denominator: 120000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what is allocated overhead as a percentage of revenue?',
  '15%', ['35%', '20%', '65%'],
  '35% is gross margin. 20% is contribution. 65% is direct cost. Overhead is €18,000 / €120,000.',
  { kind: 'canonical-ratio', numerator: 18000, denominator: 120000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what share of revenue is direct cost?',
  '65%', ['35%', '20%', '15%'],
  '35% is gross margin. 20% is contribution. 15% is overhead. Direct cost is €78,000 / €120,000.',
  { kind: 'canonical-ratio', numerator: 78000, denominator: 120000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what is the Gross Margin in euros?',
  '€42,000', ['€24,000', '€18,000', '€78,000'],
  '€24,000 is contribution. €18,000 is overhead. €78,000 is direct cost. Gross margin is revenue minus direct cost.',
  { kind: 'canonical-euro', amount: 42000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, what is the operating result (contribution) in euros?',
  '€24,000', ['€42,000', '€18,000', '€78,000'],
  '€42,000 is gross margin before overhead. €18,000 is the overhead itself. €78,000 is direct cost. Contribution is €42,000 minus €18,000.',
  { kind: 'canonical-euro', amount: 24000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, which figure is client revenue?',
  '€120,000', ['€78,000', '€42,000', '€24,000'],
  '€78,000 is direct cost. €42,000 is gross margin. €24,000 is contribution. None of those is the billing total.',
  { kind: 'canonical-euro', amount: 120000 });
canonical('canonical-portfolio',
  'Using the monthly portfolio reference, which figure is direct cost?',
  '€78,000', ['€120,000', '€42,000', '€18,000'],
  '€120,000 is revenue. €42,000 is gross margin. €18,000 is overhead. Direct cost is revenue minus gross margin.',
  { kind: 'canonical-euro', amount: 78000 });

const canonicalBench = [[9000, 6500], [12000, 8000], [10000, 7000], [8000, 5500], [14000, 9000], [16000, 10000]];
for (const [billing, payroll] of canonicalBench) {
  if (CANONICAL.revenue <= billing || CANONICAL.direct <= payroll) throw new Error('Canonical bench does not fit the reference portfolio.');
  const correct = euros(CANONICAL.gross - billing);
  canonical('canonical-bench',
    `One consultant (monthly cost: ${euros(payroll)}; billing: ${euros(billing)}) is included in the monthly portfolio reference. The consultant goes on the bench for a full month and their payroll remains in direct costs. What is the new Gross Margin for the month?`,
    correct,
    [euros(CANONICAL.gross), euros(CANONICAL.gross - payroll), euros(CANONICAL.gross - billing + payroll)],
    `${euros(CANONICAL.gross)} ignores the lost billing. ${euros(CANONICAL.gross - payroll)} subtracts payroll that already sits in direct costs. ${euros(CANONICAL.gross - billing + payroll)} adds that payroll back. Only the lost ${euros(billing)} comes out of gross margin.`,
    { kind: 'canonical-bench', billing, payroll, gross: CANONICAL.gross });
}

for (const delta of [3000, 6000, 4000, 2000]) {
  canonical('canonical-change',
    `Allocated overhead on the monthly portfolio reference increases by ${euros(delta)}. Revenue and direct costs stay the same. What is the new Gross Margin?`,
    euros(CANONICAL.gross),
    [euros(CANONICAL.gross - delta), euros(CANONICAL.gross + delta), euros(CANONICAL.contribution - delta)],
    `${euros(CANONICAL.gross - delta)} and ${euros(CANONICAL.gross + delta)} move gross margin by the overhead change. ${euros(CANONICAL.contribution - delta)} is the new contribution. Overhead sits below gross margin.`,
    { kind: 'canonical-overhead-gm', gross: CANONICAL.gross, delta });
  canonical('canonical-change',
    `Allocated overhead on the monthly portfolio reference increases by ${euros(delta)}. What is the new operating result (contribution)?`,
    euros(CANONICAL.contribution - delta),
    [euros(CANONICAL.contribution), euros(CANONICAL.gross), euros(CANONICAL.gross - delta)],
    `${euros(CANONICAL.contribution)} leaves the extra overhead in place. ${euros(CANONICAL.gross)} is gross margin, which does not change. ${euros(CANONICAL.gross - delta)} subtracts the overhead change from gross margin instead of from contribution.`,
    { kind: 'canonical-overhead-contribution', contribution: CANONICAL.contribution, delta });
}

function assertPool(section, pool, minimumTopics) {
  const items = BANK.filter(entry => entry.section === section && (entry.pool === 'both' || entry.pool === pool));
  const counts = new Map();
  for (const entry of items) counts.set(entry.topic, (counts.get(entry.topic) ?? 0) + 1);
  if (counts.size < minimumTopics) throw new Error(`${section} ${pool} bank has ${counts.size} topics.`);
  for (const [topic, count] of counts) {
    if (count < 2) throw new Error(`Topic ${topic} needs at least two items for rotation.`);
  }
}

if (BANK.length < BANK_MINIMUM) throw new Error(`Question bank has ${BANK.length} items; at least ${BANK_MINIMUM} are required.`);
if (new Set(BANK.map(entry => entry.bankId)).size !== BANK.length) throw new Error('Question bank ids are not unique.');
if (new Set(BANK.map(entry => entry.prompt)).size !== BANK.length) throw new Error('Question bank prompts are not unique.');
for (const entry of BANK) {
  if (entry.pool === 'practice' && entry.section !== 'Applied Reading') throw new Error(`Practice-only item ${entry.bankId} is in the wrong section.`);
  if (entry.usesReferenceTable && entry.pool !== 'practice') throw new Error(`Reference item ${entry.bankId} is not practice-only.`);
  if (entry.usesReferenceTable && entry.table) throw new Error(`Reference item ${entry.bankId} also carries its own table.`);
}
assertPool('Foundations', 'hiring', FOUNDATION_SLOTS);
assertPool('Applied Reading', 'hiring', APPLIED_SLOTS);
assertPool('Foundations', 'practice', FOUNDATION_SLOTS);
assertPool('Applied Reading', 'practice', APPLIED_SLOTS);

export function questionBank() {
  return BANK.map(entry => ({
    ...entry,
    alternatives: [...entry.alternatives],
    figures: entry.figures ? { ...entry.figures } : null,
  }));
}

export function clientQuestion(question) {
  const copy = {
    id: question.id,
    section: question.section,
    prompt: question.prompt,
    options: question.options.map(option => ({ id: option.id, text: option.text })),
  };
  if (question.table) copy.table = question.table;
  if (question.usesReferenceTable === true) copy.usesReferenceTable = true;
  return copy;
}

function drawTopics(items, count, required = []) {
  const byTopic = new Map();
  for (const entry of items) {
    const list = byTopic.get(entry.topic);
    if (list) list.push(entry);
    else byTopic.set(entry.topic, [entry]);
  }
  for (const topic of required) {
    if (!byTopic.has(topic)) throw new Error(`Missing required topic ${topic}.`);
  }
  const optional = shuffle([...byTopic.keys()].filter(topic => !required.includes(topic)));
  const topics = [...required, ...optional].slice(0, count);
  if (topics.length !== count) throw new Error(`Needed ${count} topics and found ${topics.length}.`);
  return topics.map(topic => {
    const choices = byTopic.get(topic);
    return choices[indexBelow(choices.length)];
  });
}

function eligible(mode) {
  return BANK.filter(entry => entry.pool === 'both' || entry.pool === mode);
}

function buildPaper(foundations, applied, mode) {
  if (foundations.length !== FOUNDATION_SLOTS || applied.length !== APPLIED_SLOTS) {
    throw new Error('Each paper draws 8 foundations and 7 applied questions.');
  }
  const practice = mode === 'practice';
  const questions = [];
  const key = {};
  const notes = {};
  const bankIds = [];
  const choiceIds = {};
  const sections = [
    ['Foundations', shuffle(foundations)],
    ['Applied Reading', shuffle(applied)],
  ];
  for (const [section, entries] of sections) {
    for (const entry of entries) {
      if (entry.section !== section) throw new Error('Drawn question is in the wrong section.');
      if (!practice && entry.usesReferenceTable) throw new Error('Hiring papers cannot depend on the practice reference table.');
      const id = crypto.randomUUID();
      const options = shuffle([entry.correct, ...entry.alternatives].map(text => ({ id: crypto.randomUUID(), text })));
      const correctId = options.find(option => option.text === entry.correct).id;
      const question = clientQuestion({
        id, section, prompt: entry.prompt, options,
        table: entry.table,
        usesReferenceTable: practice && entry.usesReferenceTable,
      });
      questions.push(question);
      notes[id] = entry.explanation;
      bankIds.push(entry.bankId);
      if (practice) {
        key[id] = correctId;
        choiceIds[id] = question.options.map(option => option.id);
      } else key[id] = [correctId];
    }
  }
  const paper = { questions, key, notes, bankIds };
  if (practice) {
    paper.choiceIds = choiceIds;
    paper.referenceTable = referenceTable;
  }
  return paper;
}

export function makePaper() {
  const items = eligible('hiring');
  return buildPaper(
    drawTopics(items.filter(entry => entry.section === 'Foundations'), FOUNDATION_SLOTS),
    drawTopics(items.filter(entry => entry.section === 'Applied Reading'), APPLIED_SLOTS),
    'hiring',
  );
}

export function drawPracticePaper() {
  const items = eligible('practice');
  return buildPaper(
    drawTopics(items.filter(entry => entry.section === 'Foundations'), FOUNDATION_SLOTS),
    drawTopics(items.filter(entry => entry.section === 'Applied Reading'), APPLIED_SLOTS, [
      'canonical-portfolio', 'canonical-bench', 'consultant-compare',
    ]),
    'practice',
  );
}

export function grade(paper, answers) {
  let score = 0;
  for (const { id } of paper.questions) {
    const selected = answers?.[id];
    if (Array.isArray(selected) && selected.length === 1 && selected[0] === paper.key[id][0]) score++;
  }
  return score;
}
