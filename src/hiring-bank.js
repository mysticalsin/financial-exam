// Worker-only hiring catalog. Papers sample this list; the client never imports it.
const FOUNDATIONS = 'Foundations';
const APPLIED = 'Applied Reading';
const APOSTROPHE = '\u2019';
const MINUS = '\u2212';
const euroFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const euros = value => '€' + euroFormatter.format(value);
const percent = value => Number(value.toFixed(1)) + '%';
const signedEuros = value => value < 0 ? MINUS + euros(-value) : euros(value);

const entries = [];

function add(section, prompt, correct, alternatives, good, bad, table) {
  entries.push({ section, prompt, correct, alternatives, explanations: { good, bad }, ...(table ? { table } : {}) });
}

function portfolioFigures(revenue, marginRate, overhead) {
  const gross = revenue * marginRate / 100;
  const direct = revenue - gross;
  const contribution = gross - overhead;
  if (!Number.isInteger(gross) || !Number.isInteger(contribution) || contribution <= 0)
    throw new Error('Portfolio figures are not usable.');
  const ratios = [
    percent(gross / revenue * 100),
    percent(direct / revenue * 100),
    percent(contribution / revenue * 100),
    percent(overhead / revenue * 100),
  ];
  if (new Set(ratios).size !== 4) throw new Error('Portfolio percentages collide for revenue ' + revenue);
  const table = {
    headers: ['Line Item', 'Amount (€)'],
    rows: [
      ['Revenue (client billing)', euros(revenue)],
      ['Direct Costs (consultant salaries + charges)', euros(direct)],
      ['Gross Margin', euros(gross)],
      ['Allocated Overhead (office, support functions)', euros(overhead)],
      ['Operating Result (Contribution)', euros(contribution)],
    ],
  };
  return { revenue, direct, gross, overhead, contribution, ratios, table };
}

function addDailyEuros(billing, cost) {
  const gross = billing - cost;
  add(FOUNDATIONS,
    `A consultant is billed to a client at ${euros(billing)}/day. Their internal daily cost (salary + employer charges) is ${euros(cost)}/day. What is the Gross Margin per day?`,
    euros(gross),
    [euros(billing + cost), euros(billing), euros(cost)],
    `Gross margin per day is billing minus internal cost: ${euros(billing)} ${MINUS} ${euros(cost)} = ${euros(gross)}.`,
    `The sum of billing and cost, or either figure alone, is not gross margin. ${euros(billing)} ${MINUS} ${euros(cost)} = ${euros(gross)}.`);
}

function addDailyPercent(billing, cost) {
  const gross = billing - cost;
  const marginPct = percent(gross / billing * 100);
  const costPct = percent(cost / billing * 100);
  const markupPct = percent(gross / cost * 100);
  add(FOUNDATIONS,
    `A consultant bills ${euros(billing)} per day and costs ${euros(cost)} per day. What is the Gross Margin %?`,
    marginPct,
    [costPct, markupPct, '100%'],
    `Gross margin % is (billing ${MINUS} cost) / billing: (${euros(billing)} ${MINUS} ${euros(cost)}) / ${euros(billing)} = ${marginPct}.`,
    `The cost ratio, a markup on cost, and 100% are not gross margin %. (${euros(billing)} ${MINUS} ${euros(cost)}) / ${euros(billing)} = ${marginPct}.`);
}

function addTeam(headcount, billing, direct) {
  const revenue = headcount * billing;
  const gross = revenue - direct;
  add(FOUNDATIONS,
    `You manage a team of ${headcount} consultants, each billed at ${euros(billing)}/month to clients. The total monthly direct cost of the team is ${euros(direct)}. What is your team${APOSTROPHE}s monthly Gross Margin?`,
    euros(gross),
    [euros(direct), euros(revenue), euros(revenue + direct)],
    `Team gross margin is total billing minus direct cost: ${headcount} × ${euros(billing)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`,
    `The cost total, the revenue total, and their sum are not the margin. ${headcount} × ${euros(billing)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`);
}

function addSimpleMargin(revenue, direct) {
  const gross = revenue - direct;
  add(FOUNDATIONS,
    `A portfolio records revenue of ${euros(revenue)} and direct costs of ${euros(direct)}. What is the Gross Margin?`,
    euros(gross),
    [euros(direct), euros(revenue), euros(revenue + direct)],
    `Gross margin is revenue minus direct cost: ${euros(revenue)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`,
    `Quoting direct cost, revenue, or their sum misses the margin. ${euros(revenue)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`);
}

function addSimpleRate(revenue, direct) {
  const gross = revenue - direct;
  const marginPct = percent(gross / revenue * 100);
  const costPct = percent(direct / revenue * 100);
  const markupPct = percent(gross / direct * 100);
  add(FOUNDATIONS,
    `Revenue is ${euros(revenue)} and direct cost is ${euros(direct)}. What is the Gross Margin %?`,
    marginPct,
    [costPct, markupPct, '100%'],
    `Gross margin % divides the euro margin by revenue: ${euros(gross)} / ${euros(revenue)} = ${marginPct}.`,
    `The cost ratio, the markup on cost, and 100% are different measures. ${euros(gross)} / ${euros(revenue)} = ${marginPct}.`);
}

function addUtilization(available, billed) {
  const rate = percent(billed / available * 100);
  const inverse = percent(available / billed * 100);
  const idle = percent((available - billed) / available * 100);
  add(FOUNDATIONS,
    `A consultant is available for ${available} days and is billed to a client for ${billed} of those days. What is the utilization?`,
    rate,
    [inverse, idle, `${billed}%`],
    `Utilization is billed days divided by available days: ${billed} / ${available} = ${rate}.`,
    `The inverse ratio, the unbilled share, and the bare day count are not utilization. ${billed} / ${available} = ${rate}.`);
}

function addDayRevenue(days, rate) {
  const revenue = rate * days;
  add(FOUNDATIONS,
    `How much client revenue do ${days} billed days produce at ${euros(rate)} per day?`,
    euros(revenue),
    [euros(rate), euros(rate * (days + 2)), euros(revenue / 2)],
    `Client revenue is the daily rate times billed days: ${days} × ${euros(rate)} = ${euros(revenue)}.`,
    `The daily rate alone, two extra days, or half the product is not the revenue. ${days} × ${euros(rate)} = ${euros(revenue)}.`);
}

function addMonthMargin(billedDays, rate, dailyCost, availableDays) {
  const revenue = rate * billedDays;
  const direct = dailyCost * availableDays;
  const gross = revenue - direct;
  add(FOUNDATIONS,
    `Over one month, billing covers ${billedDays} days at ${euros(rate)}/day while cost runs ${euros(dailyCost)}/day for ${availableDays} available days. What is the Gross Margin?`,
    euros(gross),
    [euros(revenue), euros(direct), euros(revenue + direct)],
    `Monthly gross margin keeps every available day${APOSTROPHE}s cost and only the billed days${APOSTROPHE} revenue: ${euros(revenue)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`,
    `Revenue alone, cost alone, and their sum are not the margin. ${euros(revenue)} ${MINUS} ${euros(direct)} = ${euros(gross)}.`);
}

function addPortfolioRate(revenue, marginRate, overhead) {
  const figures = portfolioFigures(revenue, marginRate, overhead);
  const prompt = revenue === 120000 && marginRate === 35 && overhead === 18000
    ? 'What is the Gross Margin % for this portfolio?'
    : `What is the Gross Margin % for the monthly portfolio with revenue of ${euros(revenue)}?`;
  add(APPLIED, prompt, figures.ratios[0], figures.ratios.slice(1),
    `Gross margin % is gross margin divided by revenue: ${euros(figures.gross)} / ${euros(figures.revenue)} = ${figures.ratios[0]}.`,
    `Direct-cost, contribution, and overhead ratios are different measures. Gross margin % is ${euros(figures.gross)} / ${euros(figures.revenue)} = ${figures.ratios[0]}.`,
    figures.table);
}

function addContribution(revenue, marginRate, overhead) {
  const figures = portfolioFigures(revenue, marginRate, overhead);
  add(APPLIED,
    `What is the Operating Result (Contribution) for the monthly portfolio with revenue of ${euros(revenue)}?`,
    euros(figures.contribution),
    [euros(figures.gross), euros(figures.overhead), euros(figures.direct)],
    `Contribution is gross margin minus allocated overhead: ${euros(figures.gross)} ${MINUS} ${euros(figures.overhead)} = ${euros(figures.contribution)}.`,
    `Gross margin, overhead, and direct cost are earlier or different lines. ${euros(figures.gross)} ${MINUS} ${euros(figures.overhead)} = ${euros(figures.contribution)}.`,
    figures.table);
}

function addBench(revenue, marginRate, overhead, payroll, billing) {
  const figures = portfolioFigures(revenue, marginRate, overhead);
  const revised = figures.gross - billing;
  add(APPLIED,
    `One consultant (monthly cost: ${euros(payroll)}; billing: ${euros(billing)}) is included in the monthly portfolio below. The consultant goes on the bench for a full month and their payroll remains in direct costs. What is the new Gross Margin for the month?`,
    euros(revised),
    [euros(figures.gross), euros(figures.gross - payroll), euros(figures.gross - billing + payroll)],
    `Billing stops while payroll stays in direct costs, so lost billing comes out of gross margin: ${euros(figures.gross)} ${MINUS} ${euros(billing)} = ${euros(revised)}.`,
    `The margin does not stay flat, and subtracting or adding payroll does not describe the bench month. ${euros(figures.gross)} ${MINUS} ${euros(billing)} = ${euros(revised)}.`,
    figures.table);
}

function addRateCut(reduction, billing, cost) {
  const before = billing - cost;
  const cut = billing * reduction / 100;
  const after = before - cut;
  add(APPLIED,
    `A client asks you to reduce the billing rate by ${reduction}% for one consultant currently billed at ${euros(billing)}/month. The consultant${APOSTROPHE}s cost remains at ${euros(cost)}/month. What happens to the Gross Margin on this consultant?`,
    `It changes from ${euros(before)} to ${euros(after)}.`,
    [
      `It changes from ${euros(before)} to ${euros(before)}.`,
      `It changes from ${euros(before)} to ${euros(after - cut)}.`,
      `It changes from ${euros(before)} to ${euros(billing - cut)}.`,
    ],
    `A ${reduction}% cut removes ${euros(cut)} of billing while cost stays ${euros(cost)}, so gross margin moves from ${euros(before)} to ${euros(after)}.`,
    `The margin does not stay flat or absorb a second cut. Removing ${euros(cut)} of billing moves it from ${euros(before)} to ${euros(after)}.`);
}

function rateLabel(rate) {
  const rounded = Math.round(rate * 100) / 100;
  return `${rounded}%`;
}

function addConsultants(billA, costA, billB, costB, canonical = false) {
  const rateA = (billA - costA) / billA * 100;
  const rateB = (billB - costB) / billB * 100;
  const winner = rateA > rateB ? 'Consultant A' : 'Consultant B';
  const prompt = canonical
    ? 'You have two consultants in your portfolio. Which generates a better Gross Margin %?'
    : `You have two consultants in your portfolio. A is billed ${euros(billA)} and B is billed ${euros(billB)}. Which generates a better Gross Margin %?`;
  add(APPLIED, prompt, winner, [winner === 'Consultant A' ? 'Consultant B' : 'Consultant A', 'They are equal', 'Cannot be determined'],
    `${winner} has the higher gross margin rate, at ${rateLabel(winner === 'Consultant A' ? rateA : rateB)} against ${rateLabel(winner === 'Consultant A' ? rateB : rateA)} for the other consultant. A larger billing amount is not a higher rate.`,
    `Equal and unknowable are not supported by the billing and cost lines. ${winner} leads on rate, at ${rateLabel(winner === 'Consultant A' ? rateA : rateB)} versus ${rateLabel(winner === 'Consultant A' ? rateB : rateA)}.`,
    {
      headers: ['', 'Consultant A', 'Consultant B'],
      rows: [
        ['Monthly Billing', euros(billA), euros(billB)],
        ['Monthly Cost', euros(costA), euros(costB)],
      ],
    });
}

function addManagers(revenueA, grossA, revenueB, grossB, canonical = false) {
  const rateA = grossA / revenueA * 100;
  const rateB = grossB / revenueB * 100;
  const winner = rateA > rateB ? 'BM Alpha' : 'BM Beta';
  const prompt = canonical
    ? `You are comparing two Business Managers${APOSTROPHE} portfolios at end of quarter. Which portfolio is more efficient from a Gross Margin % perspective?`
    : `You are comparing two Business Managers${APOSTROPHE} portfolios at end of quarter. Alpha revenue is ${euros(revenueA)} and Beta revenue is ${euros(revenueB)}. Which portfolio is more efficient from a Gross Margin % perspective?`;
  add(APPLIED, prompt, winner, [winner === 'BM Alpha' ? 'BM Beta' : 'BM Alpha', 'Both portfolios are equally efficient', 'There is not enough information to compare them'],
    `Efficiency is the gross margin rate, not the larger euro amount. ${winner} at ${rateLabel(winner === 'BM Alpha' ? rateA : rateB)} beats the other portfolio at ${rateLabel(winner === 'BM Alpha' ? rateB : rateA)}.`,
    `A larger euro gross margin can still be a lower rate. ${winner} at ${rateLabel(winner === 'BM Alpha' ? rateA : rateB)} is ahead of the other portfolio at ${rateLabel(winner === 'BM Alpha' ? rateB : rateA)}.`,
    {
      headers: ['', 'BM Alpha', 'BM Beta'],
      rows: [
        ['Revenue', euros(revenueA), euros(revenueB)],
        ['Gross Margin', euros(grossA), euros(grossB)],
      ],
    });
}

function addTarget(cost, margin) {
  const billing = cost / (1 - margin / 100);
  const markup = cost * (1 + margin / 100);
  const slice = cost * margin / 100;
  add(APPLIED,
    `A consultant costs ${euros(cost)} per month. What client billing produces a ${margin}% gross margin?`,
    euros(billing),
    [euros(cost), euros(markup), euros(slice)],
    `A ${margin}% gross margin means cost is ${100 - margin}% of billing, so the required billing is ${euros(cost)} / ${((100 - margin) / 100).toString()} = ${euros(billing)}.`,
    `The cost itself, a markup of ${margin}% on cost, and ${margin}% of the cost are not the billing that yields a ${margin}% margin. The billing is ${euros(billing)}.`);
}

function addMarginMove(prior, current, direction) {
  const dropped = direction === 'dropped';
  add(APPLIED,
    `Your Gross Margin % has ${direction} from ${prior}% to ${current}% over the last quarter while revenue remained stable. Which is the most likely cause?`,
    dropped
      ? 'Direct costs increased (e.g., salary raises or higher-cost profiles placed at the same billing rate)'
      : 'Direct costs decreased, for example a lower-cost profile or a lower salary at the same billing rate',
    dropped
      ? ['Overhead costs increased', 'You hired additional support staff', 'Taxes on the entity increased']
      : ['Overhead costs decreased', 'A support subscription was cancelled', 'Taxes on the entity decreased'],
    `Revenue was stable while the margin rate moved from ${prior}% to ${current}%. Direct cost ${dropped ? 'absorbed a larger share' : 'absorbed a smaller share'} of that same billing.`,
    `Overhead, support cost, and tax sit below gross margin. A stable-revenue move from ${prior}% to ${current}% is a direct-cost change.`);
}

function addPlacement(cost, billing) {
  const after = billing - cost;
  add(APPLIED,
    `A bench consultant costs ${euros(cost)} this month and bills nothing. Placing that consultant at ${euros(billing)} with the same cost moves their gross margin from:`,
    `${signedEuros(-cost)} to ${signedEuros(after)}`,
    [`${euros(0)} to ${euros(billing)}`, `${euros(cost)} to ${euros(billing)}`, `${signedEuros(-cost)} to ${euros(billing)}`],
    `Bench margin is the unpaid cost with no billing. Adding ${euros(billing)} of billing against that same cost produces a margin of ${signedEuros(after)}.`,
    `Ignoring the cost, treating the cost as a positive margin, or dropping the cost on placement misstates the move into ${signedEuros(after)}.`);
}

[
  [800, 500], [600, 390], [700, 420], [900, 540], [1000, 650], [1200, 750], [1400, 840], [1600, 1000],
].forEach(([billing, cost]) => addDailyEuros(billing, cost));
[
  [800, 500], [600, 390], [700, 420], [900, 540], [1000, 650], [1200, 750], [1400, 840], [1600, 1000],
].forEach(([billing, cost]) => addDailyPercent(billing, cost));
[
  [4, 10000, 28000], [3, 8000, 16800], [5, 9000, 31500], [6, 7000, 25200],
  [4, 12000, 33600], [3, 14000, 25200], [5, 11000, 38500], [6, 10000, 42000],
].forEach(([headcount, billing, direct]) => addTeam(headcount, billing, direct));
[
  [100000, 70000], [80000, 50000], [250000, 150000], [60000, 36000],
  [140000, 98000], [90000, 54000], [200000, 110000], [160000, 96000],
].forEach(([revenue, direct]) => addSimpleMargin(revenue, direct));
[
  [100000, 70000], [80000, 50000], [250000, 150000], [200000, 110000], [60000, 36000], [140000, 98000],
].forEach(([revenue, direct]) => addSimpleRate(revenue, direct));
[[20, 15], [20, 16], [20, 18], [16, 12], [18, 15]].forEach(([available, billed]) => addUtilization(available, billed));
[[18, 800], [20, 800], [15, 700], [20, 650], [10, 900], [16, 750]].forEach(([days, rate]) => addDayRevenue(days, rate));
[
  [18, 800, 500, 20], [20, 700, 400, 20], [15, 1000, 450, 20], [16, 900, 500, 20], [12, 1200, 550, 18],
].forEach(([billed, rate, cost, available]) => addMonthMargin(billed, rate, cost, available));

const portfolios = [
  [120000, 35, 18000], [100000, 40, 10000], [150000, 32, 18000], [200000, 30, 20000],
  [180000, 36, 21600], [250000, 28, 25000], [90000, 44, 9000], [160000, 38, 16000],
];
portfolios.forEach(([revenue, margin, overhead]) => addPortfolioRate(revenue, margin, overhead));
portfolios.slice(0, 6).forEach(([revenue, margin, overhead]) => addContribution(revenue, margin, overhead));
[
  [120000, 35, 18000, 6500, 9000],
  [100000, 40, 10000, 5000, 8000],
  [150000, 32, 18000, 7000, 11000],
  [200000, 30, 20000, 8000, 12000],
  [180000, 36, 21600, 9000, 14000],
  [250000, 28, 25000, 6000, 10000],
  [90000, 44, 9000, 4500, 7000],
  [160000, 38, 16000, 7500, 11500],
].forEach(([revenue, margin, overhead, payroll, billing]) => addBench(revenue, margin, overhead, payroll, billing));
[
  [10, 10000, 6500], [5, 8000, 4800], [15, 12000, 7200], [10, 14000, 8400],
  [5, 16000, 9600], [15, 9000, 5400], [10, 11000, 6600], [20, 15000, 9000],
].forEach(([reduction, billing, cost]) => addRateCut(reduction, billing, cost));
addConsultants(8000, 5500, 12000, 9000, true);
addConsultants(16000, 8000, 10000, 7000);
addConsultants(14000, 10500, 9000, 5400);
addConsultants(12000, 8400, 16000, 8000);
addConsultants(10000, 7200, 8000, 4800);
addConsultants(18000, 10800, 11000, 7700);
addManagers(300000, 90000, 500000, 120000, true);
addManagers(600000, 240000, 400000, 120000);
addManagers(500000, 150000, 300000, 120000);
addManagers(400000, 160000, 800000, 400000);
addManagers(250000, 100000, 450000, 135000);
addManagers(360000, 108000, 240000, 96000);
[
  [9000, 40], [7500, 25], [8000, 50], [8000, 20], [13000, 35], [14000, 30], [12000, 40], [11000, 45],
].forEach(([cost, margin]) => addTarget(cost, margin));
[[38, 30], [42, 34], [46, 36], [40, 30], [44, 36]].forEach(([prior, current]) => addMarginMove(prior, current, 'dropped'));
[[30, 38], [32, 40], [28, 36], [34, 42]].forEach(([prior, current]) => addMarginMove(prior, current, 'risen'));
[[6000, 8000], [7000, 10000], [8000, 8000], [5000, 9000]].forEach(([cost, billing]) => addPlacement(cost, billing));

const conceptual = [
  [FOUNDATIONS, 'What does P&L stand for?', 'Profit & Loss', ['Planning & Logistics', 'Profit & Liquidity', 'Performance & Leverage'],
    'P&L means Profit & Loss, the statement that sets revenue against costs.',
    'P&L means Profit & Loss. Planning & Logistics, Profit & Liquidity, and Performance & Leverage are not this statement.'],
  [FOUNDATIONS, 'At Amaris, Revenue is primarily generated by:', "Billing consultants' services to clients at an agreed daily or monthly rate",
    ['The number of consultants hired', 'The number of contracts signed per year', 'The overhead charged to support functions'],
    "Revenue comes from billing consultants' services to clients at an agreed daily or monthly rate.",
    "Headcount, contract counts, and overhead do not create revenue. Revenue comes from billing consultants' services to clients."],
  [FOUNDATIONS, 'In consulting, Gross Margin is best defined as:',
    'Revenue from client billing minus the direct cost of the consultants (salaries + charges)',
    ['Total revenue before any deductions', 'Revenue minus all company overhead and administrative costs', 'Net income after taxes'],
    'Gross margin is revenue from client billing minus the direct cost of the consultants (salaries + charges).',
    'Gross margin is not total revenue, profit after overhead, or net income. It is client billing minus consultant direct cost.'],
  [FOUNDATIONS, 'As a Business Manager at Amaris, which of the following is considered a direct cost on your P&L?',
    'The salary and social charges of your billable consultants',
    ['The rent of the Amaris head office', 'The marketing budget of the Amaris brand', "The CEO's compensation"],
    'The salary and social charges of billable consultants are a direct cost.',
    'Office rent, brand marketing, and CEO compensation are not direct costs. The direct cost is consultant salary and social charges.'],
  [FOUNDATIONS, 'One of your consultants is on the bench (not currently billed to any client) for a full month. Their salary is still being paid. What is the direct impact on your Gross Margin?',
    'Gross Margin decreases, as you bear the cost without generating revenue from this consultant',
    ['No impact, since the consultant is still employed', 'Gross Margin improves because there is no billing to manage', 'Gross Margin increases because the consultant is available'],
    'A bench consultant still costs salary and produces no revenue, so gross margin decreases.',
    'Staying employed, easier billing, or availability does not protect the margin. Unbilled salary makes gross margin decrease.'],
  [FOUNDATIONS, 'Which calculation is Gross Margin %?',
    '(Revenue − direct cost) / revenue',
    ['(Revenue − direct cost) / direct cost', 'Direct cost / revenue', 'Revenue / direct cost'],
    'Gross margin % divides the euro margin by revenue, which is the same as one minus the cost ratio.',
    'Dividing the margin by cost is a markup, and direct cost over revenue is the cost ratio, not the margin rate.'],
  [FOUNDATIONS, 'A markup on cost differs from gross margin % because the markup divides the margin by:',
    'Direct cost', ['Revenue', 'Allocated overhead', 'Headcount'],
    'Markup expresses the euro margin against direct cost, while gross margin % expresses that margin against revenue.',
    'Revenue is the base for the margin rate. Overhead and headcount are not the base of a cost markup.'],
  [FOUNDATIONS, 'Billing and direct cost both rise by the same euro amount. What happens?',
    'Gross margin euros stay flat and the gross margin % falls',
    ['Gross margin euros and the gross margin % both rise', 'Gross margin euros fall while the percentage stays flat', 'Only allocated overhead changes'],
    'Adding the same euros to billing and cost leaves the euro margin unchanged, while the larger revenue base lowers the percentage.',
    'The euro margin does not rise or fall here, and overhead is not the line that moved. The percentage falls because revenue grew.'],
  [FOUNDATIONS, 'Billing and direct cost both rise by the same percentage. What happens to the gross margin %?',
    'The gross margin % stays the same',
    ['The gross margin % rises by that same percentage', 'The gross margin % falls by that same percentage', 'The gross margin % becomes zero'],
    'Scaling billing and direct cost by one common percentage scales the euro margin in proportion, so the rate is unchanged.',
    'The rate does not move by that percentage and it does not fall to zero. Equal percentage growth preserves the margin rate.'],
  [FOUNDATIONS, 'Which ratio measures utilization for a staffing consultant?',
    'Billed days divided by available days',
    ['Available days divided by billed days', 'Direct cost divided by revenue', 'Gross margin divided by overhead'],
    'Utilization is the share of available days that were actually billed to a client.',
    'Inverting the days, or substituting a cost ratio or a margin-to-overhead ratio, does not measure billed time.'],
  [FOUNDATIONS, 'Client revenue for a consultant on a daily rate equals:',
    'The daily billing rate multiplied by billed days',
    ['The daily billing rate multiplied by every available day', 'The daily cost multiplied by billed days', 'The monthly salary multiplied by headcount'],
    'Only days billed to the client create revenue, and they do so at the agreed daily rate.',
    'Unbilled available days, internal cost, and headcount do not measure that client revenue.'],
  [FOUNDATIONS, `Employer social charges on a billable consultant are classified as:`,
    `Part of that consultant${APOSTROPHE}s direct cost`,
    ['Allocated overhead', 'A deduction taken after gross margin', 'Client revenue'],
    'Social charges belong to the cost of employing the billable consultant, so they sit in direct cost.',
    'They are not overhead, not an adjustment under gross margin, and not client revenue.'],
  [FOUNDATIONS, `For a business manager${APOSTROPHE}s gross margin, the CEO${APOSTROPHE}s compensation is:`,
    'Outside gross margin',
    ['A direct cost of the billed team', 'Client revenue', 'A billing discount'],
    'CEO compensation is not the direct cost of a consultant billed to a client, so it stays outside gross margin.',
    'It is not billed-team direct cost, not client revenue, and not a discount on a client rate.'],
  [FOUNDATIONS, 'Brand marketing spend, for gross margin purposes, is:',
    'Not a direct cost',
    ['A direct cost of every billed consultant', 'Added to client revenue', 'The gross margin itself'],
    'Brand marketing is not the cost of delivering a billed consultant, so it stays outside gross margin.',
    'Marketing does not sit in consultant direct cost, does not increase revenue, and is not the margin.'],
  [FOUNDATIONS, 'Head-office rent is treated as:',
    'Allocated overhead below gross margin',
    ['A direct cost of billed consultants', 'Client revenue', 'A gross margin credit'],
    'Office rent is an overhead allocation. It can change contribution after gross margin, not the margin itself.',
    'Rent is not consultant direct cost, not client revenue, and not a credit inside gross margin.'],
  [FOUNDATIONS, 'Signing additional client contracts raises revenue only when:',
    'Those contracts produce client billing',
    ['The contracts are filed', 'Headcount increases', 'Overhead is allocated to the team'],
    'Revenue follows client billing. Filing a contract, by itself, does not record revenue.',
    'A filed contract, a higher headcount, or an overhead allocation does not by itself create revenue.'],
  [FOUNDATIONS, 'Hiring a consultant who is not billed to a client:',
    'Adds direct cost and no revenue',
    ['Adds revenue immediately', 'Reduces direct cost', 'Removes allocated overhead'],
    'An unbilled consultant still costs salary and charges and does not create client revenue.',
    'The hire does not create billing, does not reduce cost, and does not remove overhead.'],
  [FOUNDATIONS, 'A credit note reduces recognized client revenue, and direct cost is unchanged. Gross margin:',
    'Falls by the credit-note amount',
    ['Rises by the credit-note amount', 'Stays the same', 'Falls only in allocated overhead'],
    'Removing recognized revenue while direct cost stays reduces gross margin by the credit amount.',
    'The margin does not rise, stay flat, or move only in overhead when revenue is credited and cost is unchanged.'],
  [FOUNDATIONS, 'An amount already included in revenue is written off, and direct cost stays the same. Gross margin:',
    'Falls by the amount written off',
    ['Rises by the amount written off', 'Is unchanged because the work was delivered', 'Moves only in tax'],
    'Reversing revenue that was already recognized, with cost unchanged, reduces gross margin by that write-off.',
    'Delivery does not protect the margin once the revenue is reversed, and the effect is not confined to tax.'],
  [FOUNDATIONS, 'A consultant spends the month on an internal project that is not billed to a client. Payroll continues. Gross margin:',
    'Falls, because the cost remains and there is no client revenue',
    ['Rises, because the work is internal', 'Is unchanged, because the consultant is still employed', 'Rises by the amount of the salary'],
    'Unbilled internal work keeps the direct cost and adds no client revenue, so gross margin falls.',
    'Calling the work internal, keeping the person employed, or pointing at the salary does not create billing.'],
  [FOUNDATIONS, 'A daily cost rate of 62.5% means:',
    'Direct cost is 62.5% of client billing',
    ['Gross margin is 62.5% of client billing', 'Overhead is 62.5% of client billing', 'Client billing is 62.5% of direct cost'],
    'The cost rate puts direct cost over billing. Whatever share is left after that cost is the gross margin rate.',
    'That quoted rate is not the margin, not overhead, and not billing divided by cost.'],
  [FOUNDATIONS, `A consultant${APOSTROPHE}s direct cost is 62.5% of client billing. What is the Gross Margin %?`,
    '37.5%', ['62.5%', '100%', '50%'],
    'Gross margin percent is what remains after the cost rate: 100 percent minus 62.5 percent leaves 37.5 percent.',
    'The cost rate itself, 100, and 50 are not this margin. Take the cost rate off 100 to reach 37.5.'],
  [FOUNDATIONS, 'Contribution differs from gross margin because contribution:',
    'Subtracts allocated overhead from gross margin',
    ['Subtracts direct cost from revenue', 'Adds overhead to revenue', 'Ignores client billing'],
    'Contribution, also called operating result, is what remains after allocated overhead comes off gross margin.',
    'Taking direct cost from revenue is gross margin itself. Overhead is not added to revenue, and billing is not ignored.'],
  [FOUNDATIONS, 'On this P&L, operating result equals:',
    'Gross margin minus allocated overhead',
    ['Revenue minus allocated overhead only', 'Direct cost minus revenue', 'Client billing plus overhead'],
    'Operating result is gross margin after the overhead allocation has been removed.',
    'It is not revenue minus overhead with direct cost skipped, not cost minus revenue, and not billing plus overhead.'],
  [FOUNDATIONS, 'Which of these ratios is not a gross margin %?',
    'Allocated overhead divided by revenue',
    ['(Revenue minus direct cost) divided by revenue', 'Gross margin divided by revenue', 'One minus direct cost divided by revenue'],
    'Overhead divided by revenue sits below gross margin. The other three expressions are the same margin rate.',
    'Margin over revenue, and one minus the cost ratio, are gross margin %. Overhead over revenue is a different ratio.'],
  [FOUNDATIONS, 'A client rate increase with no change in direct cost will:',
    'Raise gross margin euros and the gross margin %',
    ['Lower client revenue', 'Raise direct cost', 'Cut utilization automatically'],
    'More billing with the same direct cost increases both the euro margin and the margin rate.',
    'Revenue does not fall, direct cost does not rise, and utilization is not automatically cut by a higher rate.'],
  [FOUNDATIONS, 'A salary increase with no change in the client rate will:',
    'Reduce gross margin',
    ['Raise client revenue', 'Raise the gross margin %', 'Reduce direct cost'],
    'A higher salary raises direct cost while billing stays put, so gross margin falls.',
    'The client rate is unchanged, so revenue does not rise, and a higher salary does not cut cost or lift the rate.'],
  [FOUNDATIONS, 'Entity taxes, relative to gross margin, sit:',
    'Below gross margin',
    ['Inside direct cost', 'Inside client revenue', 'In the agreed billing rate by definition'],
    'Tax is outside consultant direct cost, so a tax change does not move gross margin.',
    'Tax is not direct cost, not revenue, and not automatically embedded in the billing rate.'],
  [FOUNDATIONS, 'Gross margin on a consultant is negative when:',
    'Direct cost is higher than client billing',
    ['Allocated overhead is higher than client billing', 'Tax is higher than client billing', 'Headcount is below five'],
    'That consultant margin turns negative only when their own direct cost exceeds their own billing.',
    'Overhead, tax, and headcount do not decide that consultant margin. Cost above billing does.'],
  [FOUNDATIONS, 'Two consultants are billed the same amount and have different direct costs. The better gross margin % belongs to:',
    'The consultant with the lower direct cost',
    ['The consultant with the higher direct cost', 'The consultant who joined more recently', 'Neither, because equal billing means equal margins'],
    'With equal billing, the lower direct cost leaves the larger share of that billing as gross margin.',
    'A higher cost, a later joining date, or equal billing by itself does not produce the better margin rate.'],
  [FOUNDATIONS, 'Two consultants have the same direct cost and different billing. The better gross margin % belongs to:',
    'The consultant with the higher billing',
    ['The consultant with the lower billing', 'The consultant who joined earlier', 'Neither, because equal cost means equal margins'],
    'With equal direct cost, higher billing produces both a larger euro margin and a higher margin rate.',
    'Lower billing, an earlier joining date, or equal cost by itself does not produce the better margin rate.'],
  [FOUNDATIONS, 'Two portfolios have the same gross margin in euros. The portfolio with higher revenue has:',
    'A lower gross margin %',
    ['A higher gross margin %', 'The same gross margin %', 'Automatically lower direct cost'],
    'The same euro margin spread over larger revenue is a smaller percentage, so the margin rate is lower.',
    'The percentage is not higher or equal, and the larger revenue with the same euro margin means higher direct cost.'],
  [FOUNDATIONS, 'Billing and direct cost for a margin calculation should be compared:',
    'Over the same period',
    ['After dropping the currency', 'After allocated overhead only', 'After entity tax only'],
    'A gross margin compares client billing with the direct cost that belongs to that same period.',
    'Dropping currency, or looking only at overhead or tax, does not produce the margin comparison.'],
  [FOUNDATIONS, 'Employer social charges on billable consultants:',
    'Increase direct cost',
    ['Increase client revenue', 'Increase gross margin by themselves', 'Cut direct cost'],
    'Those charges are added to the cost of the billable consultant, which raises direct cost and lowers gross margin.',
    'The charges do not create revenue, do not lift margin on their own, and do not reduce direct cost.'],
  [FOUNDATIONS, 'Which of these is excluded from client revenue?',
    'Unbilled bench time',
    ['Days billed to a client at the agreed rate', 'A monthly fee for a consultant staffed at a client', 'An agreed daily rate multiplied by billed days'],
    'Bench time is not invoiced to a client, so it is outside revenue, unlike billed days and agreed fees.',
    'Billed days, a staffed monthly fee, and daily rate times billed days are revenue. Unbilled bench time is not.'],
  [FOUNDATIONS, 'A billed day is lost and payroll for that day is still paid. The direct P&L effect is:',
    'Revenue falls, direct cost stays, and gross margin falls',
    ['Allocated overhead falls', 'Entity tax falls', 'Client revenue rises'],
    'The lost day removes its billing and leaves its cost in place, so gross margin falls by the lost billing.',
    'Overhead and tax do not record that lost day, and revenue does not rise when billing disappears.'],
  [FOUNDATIONS, 'Gross margin euros can rise while the gross margin % falls when:',
    'Revenue grows by more than the euro margin grows',
    ['Direct cost falls and revenue stays flat', 'Allocated overhead is cut', 'Revenue falls and direct cost stays flat'],
    'When revenue grows faster than the euro margin, the margin becomes a smaller percentage even though the euros rose.',
    'A cost cut with flat revenue lifts both measures, an overhead cut is below the margin, and falling revenue does not lift margin euros.'],
  [FOUNDATIONS, 'A cost recharged to the client with no markup has a gross margin of:',
    'Zero',
    ['The full recharge amount', 'The overhead rate', 'The consultant salary'],
    'When the recharge billed to the client equals its cost, that slice contributes no euro gross margin.',
    'The full recharge, an overhead rate, and a salary are not the margin on a pass-through billed at cost.'],
  [FOUNDATIONS, 'A 0% gross margin means:',
    'Client billing equals direct cost',
    ['Client billing is zero', 'Allocated overhead is zero', 'The consultant must be on the bench'],
    'A zero margin rate means billing and direct cost are equal, so nothing remains after direct cost.',
    'Billing need not be zero, overhead is a later line, and bench time with ongoing pay is usually a negative margin.'],
  [FOUNDATIONS, 'Contribution is positive when:',
    'Gross margin is larger than allocated overhead',
    ['Revenue is larger than allocated overhead', 'Direct cost is larger than revenue', 'Entity tax is zero'],
    'Contribution equals gross margin minus overhead, so it is positive only when the margin covers that overhead.',
    'Revenue above overhead can still hide a thin margin, cost above revenue is not a positive contribution, and tax is not the test.'],
  [FOUNDATIONS, 'The agreed fee is €10,000 for a full month, and the consultant is billed for half of that month. What revenue is recorded?',
    '€5,000', ['€10,000', '€20,000', '€0'],
    'Half of a full-month fee of €10,000 is €5,000 of client revenue.',
    'Recording the full fee, double the fee, or nothing would misstate a half-month billing of that €10,000 rate.'],
  [FOUNDATIONS, 'The salary of an internal support profile who is not billed to a client is:',
    'Outside billable direct cost',
    ['The direct cost of a billed consultant', 'Client revenue', 'A discount on a client rate'],
    'Unbilled support pay is not the direct cost of a consultant placed at a client, so it stays outside gross margin.',
    'It is not billed-consultant direct cost, not client revenue, and not a discount on a client rate.'],
  [APPLIED, 'As a Business Manager, which of the following actions has the most direct positive impact on your Gross Margin?',
    'Placing a bench consultant quickly at a billing rate above their cost',
    ['Reducing the number of internal meetings', 'Requesting a lower office space allocation', 'Hiring a new support profile in your team'],
    'Placing a bench consultant above their cost adds revenue over direct cost and lifts gross margin.',
    'Fewer meetings, a smaller office, and a new support profile do not add client billing above direct cost. Placing a bench consultant above cost does.'],
  [APPLIED, 'Cutting allocated overhead improves:',
    'Contribution, and it leaves gross margin unchanged',
    ['Gross margin, and it leaves contribution unchanged', 'Client revenue', 'Direct cost'],
    'Overhead is deducted after gross margin, so a smaller allocation raises contribution and leaves the margin as it was.',
    'Gross margin, client revenue, and direct cost do not move when only the overhead allocation changes.'],
  [APPLIED, 'Which order matches the five-line portfolio P&L?',
    'Revenue, direct costs, gross margin, overhead, contribution',
    ['Contribution, overhead, gross margin, direct costs, revenue', 'Tax, revenue, gross margin, overhead, direct costs', 'Overhead, revenue, direct costs, tax, contribution'],
    'Read the portfolio from client revenue, through direct cost and gross margin, then overhead, and finish at contribution.',
    'Starting at contribution, tax, or overhead does not follow the five lines from revenue down to contribution.'],
  [APPLIED, 'The gross margin line on the portfolio should equal:',
    'Revenue minus direct costs',
    ['Revenue minus allocated overhead', 'Contribution plus revenue', 'Direct costs plus overhead'],
    'The gross margin line is client revenue minus direct cost, before any overhead allocation.',
    'Subtracting overhead, adding contribution to revenue, or adding overhead to cost does not reconcile gross margin.'],
  [APPLIED, 'The contribution line on the portfolio should equal:',
    'Gross margin minus allocated overhead',
    ['Revenue minus allocated overhead', 'Direct costs minus allocated overhead', 'Revenue minus direct costs'],
    'The contribution line takes allocated overhead off gross margin.',
    'Revenue minus overhead skips direct cost, and revenue minus direct cost is the gross margin line rather than contribution.'],
  [APPLIED, 'Before trusting a portfolio gross margin, check it against:',
    'Revenue minus direct costs',
    ['Contribution plus entity tax', 'Overhead plus headcount', 'The largest figure on the page'],
    'A trustworthy gross margin line reconciles to client revenue minus direct cost.',
    'Tax, headcount, overhead, and whichever figure is largest are not the reconciliation for gross margin.'],
  [APPLIED, 'A larger euro gross margin is not the more efficient portfolio when:',
    'Its gross margin % is lower',
    ['Its revenue is smaller', 'Its overhead is lower', 'Both portfolios have the same gross margin %'],
    'Efficiency in this comparison is the margin rate. A bigger pile of euro margin can still be a thinner percentage of revenue.',
    'Smaller revenue, lower overhead, or an equal rate is not the case where the larger euro margin is the less efficient one.'],
  [APPLIED, 'Before accepting a rate discount, a business manager should check that:',
    'Billing after the discount still leaves an acceptable margin over direct cost',
    ['The client logo is well known', 'Head-office rent will fall', 'Entity tax will fall'],
    'A discount cuts billing, so it is workable only when the remaining billing still clears direct cost by enough margin.',
    'A recognizable logo, lower rent, or lower tax does not show whether the discounted rate still clears direct cost.'],
  [APPLIED, 'Adding a consultant whose own gross margin % equals the current portfolio gross margin % will:',
    'Leave the portfolio gross margin % unchanged',
    ['Always raise the portfolio gross margin %', 'Always lower the portfolio gross margin %', 'Set the portfolio gross margin % to zero'],
    'A new assignment at the same rate as the existing portfolio leaves the weighted margin rate where it was.',
    'Matching the current rate does not lift it, dilute it, or reset it to zero.'],
  [APPLIED, 'Adding revenue at a gross margin % below the portfolio’s current rate will:',
    'Lower the portfolio gross margin %',
    ['Raise the portfolio gross margin %', 'Leave the portfolio gross margin % unchanged', 'Remove allocated overhead'],
    'Mixing in revenue at a lower rate than the portfolio pulls the combined gross margin % down.',
    'Below-average revenue does not raise the combined rate, leave that rate untouched, or remove overhead.'],
  [APPLIED, 'Adding revenue at a gross margin % above the portfolio’s current rate will:',
    'Raise the portfolio gross margin %',
    ['Lower the portfolio gross margin %', 'Leave the portfolio gross margin % unchanged', 'Increase the direct-cost ratio by definition'],
    'Mixing in revenue at a higher rate than the portfolio pulls the combined gross margin % up.',
    'Above-average revenue does not dilute the combined rate, leave it flat, or raise the cost ratio by definition.'],
  [APPLIED, 'One billed day is missed inside an otherwise billed month. Direct cost for that day still applies. The day:',
    'Removes one day of revenue and keeps that day’s cost',
    ['Removes the whole month of direct cost', 'Doubles the client rate', 'Eliminates allocated overhead'],
    'The missed day drops that day of billing and leaves that day of cost inside direct cost.',
    'One missed day does not erase the month of cost, double the rate, or clear the overhead allocation.'],
  [APPLIED, 'A consultant’s billing stops for a full month while their payroll remains in direct cost. That month:',
    'Removes the month’s billing from gross margin',
    ['Removes the month’s payroll from gross margin', 'Increases client revenue', 'Sets the salary to zero'],
    'With billing stopped and payroll still in direct cost, gross margin loses the month of billing.',
    'The payroll is not removed from the margin, revenue does not increase, and the salary does not fall to zero.'],
  [APPLIED, 'A figure labeled operating result (contribution) has already deducted:',
    'Allocated overhead',
    ['Only entity tax', 'Only a client discount', 'Headcount'],
    'Contribution is gross margin after allocated overhead, so that overhead is already out of the figure.',
    'Entity tax, a client discount, and headcount are not what the contribution line has already taken out.'],
  [APPLIED, 'Two portfolios have the same gross margin % and different revenue. They have:',
    'The same efficiency and different euro gross margins',
    ['The same euro gross margin', 'No usable revenue comparison', 'Equal allocated overhead by definition'],
    'An equal margin rate is equal efficiency. Different revenue then produces different euro margins.',
    'Equal rates do not force equal euro margins or equal overhead, and the two revenues can still be compared.'],
  [APPLIED, 'Portfolio Alpha has the higher gross margin % and the lower revenue, and its euro gross margin is smaller. On a percentage basis the more efficient portfolio is:',
    'Alpha',
    ['The portfolio with the larger euro gross margin', 'The portfolio with the larger revenue', 'Neither, because efficiency is measured by headcount'],
    'Percentage efficiency follows the higher gross margin rate, even when both the euro margin and the revenue are smaller.',
    'The larger euro margin, the larger revenue, and headcount do not outrank the higher margin rate.'],
  [APPLIED, 'Allocated overhead changes and revenue, direct cost, and gross margin stay the same. Which line changes?',
    'Contribution',
    ['Gross margin', 'Revenue', 'Direct cost'],
    'Overhead is taken off after gross margin, so a new overhead figure changes contribution only.',
    'Revenue, direct cost, and gross margin were unchanged, so none of those three lines moved.'],
  [APPLIED, 'Revenue and direct cost both increase by 10%. What happens to the gross margin %?',
    'It stays the same',
    ['It rises by 10 points', 'It falls by 10 points', 'It becomes zero'],
    'Growing revenue and direct cost by 10% grows the euro margin by 10% as well, so the rate is unchanged.',
    'The rate does not gain 10 points, lose 10 points, or fall to zero when both sides grow by the same percentage.'],
  [APPLIED, 'Revenue and direct cost both increase by €5,000. What happens to gross margin euros?',
    'They stay the same',
    ['They rise by €5,000', 'They fall by €5,000', 'They double'],
    'Adding €5,000 of revenue and €5,000 of direct cost leaves the euro gap between them unchanged.',
    'The euro margin does not rise by €5,000, fall by €5,000, or double. The two increases offset in the margin.'],
  [APPLIED, 'A portfolio has higher revenue and a lower gross margin % than another portfolio. On margin rate it is:',
    'Less efficient',
    ['Always the better portfolio', 'Always loss-making', 'Not comparable'],
    'The margin rate is the efficiency comparison. A lower rate is less efficient even when revenue is higher.',
    'Higher revenue does not make the portfolio better or incomparable, and a lower rate is not automatically a loss.'],
  [APPLIED, 'Contribution as a percentage of revenue is:',
    'A different ratio from gross margin %',
    ['Always equal to gross margin %', 'Always higher than gross margin %', 'Direct cost divided by revenue'],
    'Contribution percentage also deducts overhead, so it is not the gross margin rate.',
    'It is not automatically equal to the margin rate, not higher than that rate when overhead is positive, and not the cost ratio.'],
  [APPLIED, 'Contribution is negative while gross margin is positive. The direct reading is:',
    'Allocated overhead is larger than gross margin',
    ['Client revenue is zero', 'Direct cost is zero', 'The portfolio has no consultants'],
    'A positive gross margin and a negative contribution means the overhead allocation was larger than the margin.',
    'Revenue and direct cost are not zero in that pattern, and the portfolio can still contain consultants.'],
  [APPLIED, 'Portfolio North shows €40,000 of gross margin on €100,000 of revenue. Portfolio South shows €40,000 of gross margin on €160,000 of revenue. Which has the higher gross margin %?',
    'North',
    ['South', 'They are equal', 'Cannot be determined without overhead'],
    'North keeps €40,000 out of €100,000, which is 40 percent. South keeps €40,000 out of €160,000, which is 25 percent.',
    'Equal euro margins are not equal rates, and overhead is not required to compare these two gross margin rates.'],
  [APPLIED, 'A client cuts one consultant’s billing by 15% and the consultant’s cost does not change. Gross margin falls by:',
    '15% of the billing',
    ['15% of the direct cost', '15% of allocated overhead', 'Nothing, because the cost did not change'],
    'The rate cut removes 15% of billing from revenue and therefore from gross margin, because direct cost stays put.',
    'The reduction is not 15% of cost or of overhead, and an unchanged cost does not hold the margin flat.'],
  [APPLIED, 'Winning new work at a margin below the portfolio average will:',
    'Dilute the portfolio gross margin %',
    ['Raise the portfolio gross margin %', 'Leave the portfolio gross margin % unchanged', 'Eliminate allocated overhead'],
    'New billing below the portfolio rate pulls the combined gross margin % downward.',
    'That work does not lift the combined rate, leave the combined rate untouched, or remove overhead.'],
  [APPLIED, 'Which comparison measures portfolio efficiency in this assessment?',
    'Gross margin %',
    ['Headcount', 'Absolute revenue', 'The number of contracts signed'],
    'Efficiency is the share of each revenue euro left after direct cost, which is the gross margin rate.',
    'Headcount, revenue euros alone, and a count of contracts do not state that margin rate.'],
  [APPLIED, 'A client rate increase of €50 per billed day applies to 18 billed days, and direct cost is unchanged. Gross margin rises by:',
    '€900', ['€50', '€18', '€1,800'],
    'Eighteen billed days times a €50 higher rate is €900 of extra billing, and direct cost does not absorb it.',
    'The €50 rate by itself, the count of 18 days, and a doubled €1,800 are not the increase. Eighteen times €50 is €900.'],
  [APPLIED, 'Direct cost runs €40 above plan on each of 20 days, and billing is unchanged. Gross margin falls by:',
    '€800', ['€40', '€20', '€1,600'],
    'Twenty days times a €40 daily overrun is €800 of extra direct cost, so gross margin falls by that €800.',
    'The daily €40, the count of 20 days, and a doubled €1,600 are not the total. Twenty times €40 is €800.'],
];

for (const [section, prompt, correct, alternatives, good, bad] of conceptual) add(section, prompt, correct, alternatives, good, bad);

function visibleFields(entry) {
  const fields = [entry.prompt, entry.correct, ...entry.alternatives];
  if (entry.table) fields.push(...entry.table.headers, ...entry.table.rows.flat());
  return fields.filter(field => typeof field === 'string');
}

function validate(bank) {
  if (bank.length < 150 || bank.length > 220) throw new Error('Hiring bank size ' + bank.length + ' is outside 150-220.');
  const foundations = bank.filter(entry => entry.section === FOUNDATIONS).length;
  const applied = bank.filter(entry => entry.section === APPLIED).length;
  if (foundations < 40 || applied < 40) throw new Error('Hiring bank sections are unbalanced.');
  const prompts = new Set();
  const corpus = [];
  for (const entry of bank) {
    if (prompts.has(entry.prompt)) throw new Error('Duplicate hiring prompt: ' + entry.prompt);
    prompts.add(entry.prompt);
    const choices = [entry.correct, ...entry.alternatives];
    if (choices.length !== 4 || new Set(choices).size !== 4) throw new Error('Choices are not four distinct values: ' + entry.prompt);
    if (!entry.explanations || entry.explanations.good === entry.explanations.bad ||
      entry.explanations.good.length < 24 || entry.explanations.bad.length < 24)
      throw new Error('Explanations are missing or too short: ' + entry.prompt);
    if (entry.correct.length >= 12 && entry.prompt.includes(entry.correct))
      throw new Error('Prompt repeats the correct choice: ' + entry.prompt);
    for (const field of visibleFields(entry)) {
      if (field.includes(entry.explanations.good) || field.includes(entry.explanations.bad))
        throw new Error('Explanation is visible on its own question: ' + entry.prompt);
    }
    corpus.push(JSON.stringify({ prompt: entry.prompt, choices, table: entry.table ?? null }));
    for (const text of [entry.prompt, entry.correct, ...entry.alternatives, entry.explanations.good, entry.explanations.bad]) {
      if (text.includes('"key":') || text.includes('"correct":') || text.includes('"explanation":'))
        throw new Error('Private field text leaked into hiring content.');
    }
  }
  const visible = corpus.join('\n');
  for (const entry of bank) {
    if (visible.includes(entry.explanations.good) || visible.includes(entry.explanations.bad))
      throw new Error('Explanation appears in issued hiring text: ' + entry.prompt);
  }
}

validate(entries);

export const HIRING_BANK = Object.freeze(entries.map(entry => {
  const frozen = {
    section: entry.section,
    prompt: entry.prompt,
    correct: entry.correct,
    alternatives: Object.freeze([...entry.alternatives]),
    explanations: Object.freeze({ ...entry.explanations }),
  };
  if (entry.table) {
    frozen.table = Object.freeze({
      headers: Object.freeze([...entry.table.headers]),
      rows: Object.freeze(entry.table.rows.map(row => Object.freeze([...row]))),
    });
  }
  return Object.freeze(frozen);
}));
