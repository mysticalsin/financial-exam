// Local wall-clock split for paper assembly versus scoring.
// This is not a Workers CPU profile: isolate timers do not advance during CPU-only work,
// and this machine is not a Cloudflare edge CPU. See docs/HOT-PATH.md.

import { grade, makePaper } from "../src/bank.js";
import { makePracticePaper, scorePractice } from "../src/practice.js";

const iterations = 400;

function elapsed(run) {
  const start = performance.now();
  const value = run();
  return { ms: performance.now() - start, value };
}

function integerCaseMath(count) {
  let accumulator = 0;
  for (let index = 0; index < count; index++) {
    const billing = 800 + (index % 6) * 200;
    const cost = billing * (60 + (index % 7) * 2.5) / 100;
    const dailyMargin = (billing - cost) / billing * 100;
    const headcount = 3 + (index % 4);
    const teamRevenue = headcount * (7000 + (index % 8) * 1000);
    const teamGross = teamRevenue - teamRevenue * 65 / 100;
    const revenue = 90000 + (index % 2101) * 100;
    const marginRate = 28 + (index % 19);
    const gross = revenue * marginRate / 100;
    const overhead = Math.ceil(revenue * 0.08 / 10) * 10;
    accumulator += dailyMargin + teamGross + (revenue - gross) + (gross - overhead);
  }
  return accumulator;
}

for (let warm = 0; warm < 20; warm++) {
  grade(makePaper(), {});
  scorePractice(makePracticePaper(), {});
}

const originalRandom = crypto.getRandomValues.bind(crypto);
let randomCalls = 0;
let randomBytes = 0;
crypto.getRandomValues = array => {
  randomCalls++;
  randomBytes += array.byteLength;
  return originalRandom(array);
};

const recruitmentPapers = [];
const recruitmentBuild = elapsed(() => {
  for (let index = 0; index < iterations; index++) recruitmentPapers.push(makePaper());
});
const recruitmentRandomCalls = randomCalls;
const recruitmentRandomBytes = randomBytes;
randomCalls = 0;
randomBytes = 0;

const practicePapers = [];
const practiceBuild = elapsed(() => {
  for (let index = 0; index < iterations; index++) practicePapers.push(makePracticePaper());
});
const practiceRandomCalls = randomCalls;
crypto.getRandomValues = originalRandom;

const gradeRepeats = 20;
const recruitmentGrade = elapsed(() => {
  let total = 0;
  for (let repeat = 0; repeat < gradeRepeats; repeat++) {
    for (const paper of recruitmentPapers) total += grade(paper, paper.key);
  }
  return total;
});
const practiceGrade = elapsed(() => {
  let total = 0;
  for (let repeat = 0; repeat < gradeRepeats; repeat++) {
    for (const paper of practicePapers) total += scorePractice(paper, paper.key).score;
  }
  return total;
});
const arithmeticRepeats = 50;
const arithmetic = elapsed(() => integerCaseMath(iterations * arithmeticRepeats));
const formatRepeats = 40;
const euro = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const formatting = elapsed(() => {
  let total = 0;
  for (let index = 0; index < iterations * formatRepeats; index++) {
    total += euro.format(90000 + (index % 2101) * 100).length;
  }
  return total;
});
const identifiers = elapsed(() => {
  let last = "";
  for (let index = 0; index < iterations * 75; index++) last = crypto.randomUUID();
  return last.length;
});

const round = value => Number(value.toFixed(2));
const ratio = value => Number(value.toFixed(4));
const gradeMs = recruitmentGrade.ms / gradeRepeats;
const arithmeticMs = arithmetic.ms / arithmeticRepeats;
const report = {
  runtime: `Node ${process.version}`,
  clock: "performance.now wall time on this machine, after 20 warmup papers. Short sections are repeated and divided back to one pass.",
  iterations,
  recruitment: {
    makePaperMs: round(recruitmentBuild.ms),
    gradeAllCorrectMs: round(gradeMs),
    integerCaseModelMs: round(arithmeticMs),
    euroFormatModelMs: round(formatting.ms),
    gradeShareOfMakePlusGrade: ratio(gradeMs / (recruitmentBuild.ms + gradeMs)),
    integerModelShareOfMakePaper: ratio(arithmeticMs / recruitmentBuild.ms),
    getRandomValuesCallsPerPaper: round(recruitmentRandomCalls / iterations),
    getRandomValuesBytesPerPaper: round(recruitmentRandomBytes / iterations),
    scored: recruitmentGrade.value,
  },
  practice: {
    makePracticePaperMs: round(practiceBuild.ms),
    scorePracticeMs: round(practiceGrade.ms / gradeRepeats),
    getRandomValuesCallsPerPaper: round(practiceRandomCalls / iterations),
    scored: practiceGrade.value,
  },
  randomUuidFor75IdsMs: round(identifiers.ms),
  note: "Shares are ratios of local wall time, not Workers CPU samples. euroFormatModelMs is 40 en-GB formats per paper, an upper bound on the currency strings a paper builds.",
};

console.log(JSON.stringify(report, null, 2));
if (recruitmentGrade.value !== iterations * gradeRepeats * 15 || practiceGrade.value !== iterations * gradeRepeats * 15) {
  console.error("Profile scored an unexpected total.");
  process.exitCode = 1;
}
