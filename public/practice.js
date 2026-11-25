const $ = (id) => document.getElementById(id);
const panel = $("workspace");
const dialog = $("dialog");
let questions = [];
let referenceTable = null;
let answers = Object.create(null);
let challenge = "";
let deadline = 0;
let clockBase = null;
let phase = "idle";
let score = null;
let total = 0;
let resultAnswered = 0;
let resultUntil = 0;
let requestVersion = 0;
let submissionPending = false;
let activeFilter = "all";
let currentQuestionIndex = 0;
let stickyQuestionIndex = -1;
let practiceTimerCue = "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function clearStatus() { $("system-status").replaceChildren(); }
function observeLandingLedger() {
  const ledger = document.querySelector(".studio-ledger");
  if (!ledger) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    ledger.classList.add("is-visible");
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      ledger.classList.add("is-visible");
      observer.disconnect();
    }
  }, { threshold: 0.12 });
  observer.observe(ledger);
}
function showStatus(message, retry) {
  const status = $("system-status");
  status.replaceChildren(el("span", "", message));
  if (retry) status.append(button("Try again", "text-action", retry));
}
function showWorkspace() {
  $("landing").hidden = true;
  $("outline").hidden = true;
  panel.hidden = false;
  document.body.classList.add("practice-active");
  clearStatus();
}
function showHome() {
  panel.hidden = true;
  panel.replaceChildren();
  $("landing").hidden = false;
  $("outline").hidden = false;
  document.body.classList.remove("practice-active");
  clearStatus();
  const title = $("landing-title");
  if (title) {
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
}
function clearPractice() {
  requestVersion++;
  questions = [];
  referenceTable = null;
  answers = Object.create(null);
  challenge = "";
  deadline = 0;
  clockBase = null;
  score = null;
  total = 0;
  resultAnswered = 0;
  resultUntil = 0;
  submissionPending = false;
  activeFilter = "all";
  currentQuestionIndex = 0;
  stickyQuestionIndex = -1;
  practiceTimerCue = "";
  if (dialog.open) dialog.close();
  $("dialog-body").replaceChildren();
}
function serverTime() { return clockBase.server + performance.now() - clockBase.local; }
function remainingSeconds() { return Math.max(0, Math.ceil((deadline - serverTime()) / 1000)); }
function answeredCount() { return Object.keys(answers).filter((id) => Boolean(answers[id])).length; }
function validTable(table) {
  return table && Array.isArray(table.headers) && Array.isArray(table.rows) &&
    table.headers.length > 0 && table.headers.every((x) => typeof x === "string") &&
    table.rows.every((row) => Array.isArray(row) && row.length === table.headers.length && row.every((x) => typeof x === "string"));
}
function isValidQuestion(question) {
  return question && typeof question.id === "string" && typeof question.section === "string" &&
    typeof question.prompt === "string" && Array.isArray(question.options) && question.options.length >= 2 &&
    question.options.every((option) => typeof option.id === "string" && typeof option.text === "string") &&
    new Set(question.options.map((option) => option.id)).size === question.options.length &&
    (!question.table || validTable(question.table)) &&
    (question.usesReferenceTable === undefined || typeof question.usesReferenceTable === "boolean");
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/api/practice/" + path, {
      method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.error === "string" ? data.error : "The practice service could not complete this request.");
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.status) throw error;
    const offline = new Error("We could not connect. Your answers remain in this page. Reconnect and try again.");
    offline.status = 0;
    throw offline;
  } finally { clearTimeout(timeout); }
}
async function start() {
  clearPractice();
  window.scrollTo({ top: 0, behavior: "instant" });
  const version = requestVersion;
  phase = "loading";
  showWorkspace();
  panel.replaceChildren(el("section", "content-card narrow loading-card", "Preparing your practice paper…"));
  try {
    const data = await api("start", {});
    if (version !== requestVersion) return;
    if (!Array.isArray(data.questions) || data.questions.length !== 15 || !data.questions.every(isValidQuestion) ||
        new Set(data.questions.map((q) => q.id)).size !== 15 || typeof data.challenge !== "string" || !data.challenge ||
        !Number.isFinite(data.serverNow) || !Number.isFinite(data.deadline) || data.deadline <= data.serverNow ||
        (data.referenceTable && !validTable(data.referenceTable))) {
      throw new Error("The practice assessment could not be opened. Try again.");
    }
    questions = data.questions;
    referenceTable = data.referenceTable || null;
    challenge = data.challenge;
    total = questions.length;
    deadline = data.deadline;
    clockBase = { server: data.serverNow, local: performance.now() };
    phase = "paper";
    renderPaper(true);
  } catch (error) {
    if (version !== requestVersion) return;
    clearPractice();
    phase = "error";
    showHome();
    showStatus(error.message || "The practice assessment could not be loaded. Try again.", start);
  }
}
function showPreflight() {
  if (phase !== "idle" && phase !== "error") return;
  const title = el("h2", "", "Before you begin"); title.id = "dialog-title";
  const tabs = el("div", "preflight-tabs"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "Practice guide");
  const paperTab = button("Your paper", "preflight-tab is-selected", () => setGuide("paper"));
  paperTab.id = "preflight-paper"; paperTab.setAttribute("aria-pressed", "true");
  const exampleTab = button("Try a question", "preflight-tab", () => setGuide("example"));
  exampleTab.id = "preflight-example"; exampleTab.setAttribute("aria-pressed", "false");
  tabs.append(paperTab, exampleTab);
  const paperPanel = el("section", "preflight-panel"); paperPanel.id = "preflight-paper-panel"; paperPanel.setAttribute("aria-labelledby", paperTab.id);
  const overview = el("div", "preflight-parts");
  [["01–08", "Foundations", "Core financial concepts"], ["09–15", "Applied reading", "Portfolio P&L decisions"]].forEach(([range, label, detail]) => {
    const part = el("div", "preflight-part"); part.append(el("span", "preflight-range", range), el("strong", "", label), el("small", "", detail)); overview.append(part);
  });
  const note = el("p", "preflight-lead", "Take 15 minutes. Calculator use is fine, and every answer stays editable until you submit. A refresh clears the paper; your score is shown only here, and no practice record is saved.");
  paperPanel.append(overview, note);
  const examplePanel = el("section", "preflight-panel", ""); examplePanel.id = "preflight-example-panel"; examplePanel.setAttribute("aria-labelledby", exampleTab.id); examplePanel.hidden = true;
  examplePanel.append(el("p", "example-label", "A QUICK WARM-UP"), el("p", "example-prompt", "€100 revenue − €60 cost. What is the gross margin in euros?"));
  const exampleChoices = el("div", "example-choices"); exampleChoices.setAttribute("role", "group"); exampleChoices.setAttribute("aria-label", "Choose the gross margin amount");
  const feedback = el("p", "example-feedback"); feedback.id = "preflight-example-feedback"; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite"); feedback.textContent = "Choose an answer to see a quick explanation.";
  [["€40", true], ["€60", false]].forEach(([label, correct]) => {
    exampleChoices.append(button(label, "example-choice", () => {
      exampleChoices.querySelectorAll("button").forEach((choice) => { choice.classList.remove("is-correct", "is-incorrect"); });
      const choice = [...exampleChoices.querySelectorAll("button")].find((item) => item.textContent === label);
      choice.classList.add(correct ? "is-correct" : "is-incorrect");
      feedback.textContent = correct ? "Correct. €100 − €60 = €40 gross margin." : "Not quite. Subtract cost from revenue: €100 − €60 = €40.";
    }));
  });
  examplePanel.append(exampleChoices, feedback);
  function setGuide(which) {
    const showPaper = which === "paper";
    paperTab.classList.toggle("is-selected", showPaper); exampleTab.classList.toggle("is-selected", !showPaper);
    paperTab.setAttribute("aria-pressed", String(showPaper)); exampleTab.setAttribute("aria-pressed", String(!showPaper));
    paperPanel.hidden = !showPaper; examplePanel.hidden = showPaper;
  }
  const actions = el("div", "action-row");
  actions.append(button("Not now", "button secondary", () => dialog.close()));
  const begin = button("Start 15-minute practice", "button primary", () => { dialog.close(); start(); });
  begin.id = "practice-begin";
  actions.append(begin);
  $("dialog-body").replaceChildren(title, tabs, paperPanel, examplePanel, actions);
  dialog.showModal();
  begin.focus({ preventScroll: true });
}
function renderTable(table, caption) {
  const wrapper = el("div", "table-card");
  const heading = el("h3", "table-caption", caption);
  const scroll = el("div", "table-scroll");
  const node = el("table", "practice-table");
  const cap = el("caption", "visually-hidden", caption);
  const thead = el("thead");
  const trh = el("tr");
  table.headers.forEach((text) => { const th = el("th", "", text); th.scope = "col"; trh.append(th); });
  thead.append(trh);
  const tbody = el("tbody");
  table.rows.forEach((row) => {
    const tr = el("tr");
    row.forEach((text, index) => {
      const cell = el(index ? "td" : "th", "", text);
      if (index === 0) cell.scope = "row";
      tr.append(cell);
    });
    tbody.append(tr);
  });
  node.append(cap, thead, tbody);
  scroll.append(node);
  wrapper.append(heading, scroll);
  return wrapper;
}
function amount(text) {
  let normalized = text.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (/[,\.]\d{3}$/.test(normalized)) normalized = normalized.replace(/[,.]/g, "");
  else normalized = normalized.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}
function portfolioViz(table) {
  const values = table.rows.map((row) => ({ label: row[0].toLowerCase(), value: amount(row[1] || "") }));
  const revenue = values.find((x) => x.label.includes("revenue"))?.value || 120000;
  const costs = values.find((x) => x.label.includes("direct cost"))?.value || 78000;
  const margin = values.find((x) => x.label.includes("gross margin"))?.value || Math.max(0, revenue - costs);
  const figure = el("figure", "portfolio-viz");
  figure.setAttribute("aria-labelledby", "portfolio-viz-title");
  const caption = el("figcaption", "viz-title", "The monthly portfolio at a glance");
  caption.id = "portfolio-viz-title";
  figure.append(caption);
  const bar = el("div", "portfolio-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `Revenue ${revenue.toLocaleString("en-US")} euros: direct costs ${costs.toLocaleString("en-US")} euros and gross margin ${margin.toLocaleString("en-US")} euros.`);
  const costSegment = el("span", "bar-costs");
  costSegment.style.width = `${Math.min(100, Math.max(0, costs / revenue * 100))}%`;
  const marginSegment = el("span", "bar-margin");
  marginSegment.style.width = `${Math.min(100, Math.max(0, margin / revenue * 100))}%`;
  bar.append(costSegment, marginSegment);
  const key = el("div", "viz-key");
  [["costs", "Direct costs", costs], ["margin", "Gross margin", margin], ["revenue", "Revenue", revenue]].forEach(([kind, label, value]) => {
    const item = el("div", "viz-key-item");
    const swatch = el("span", `viz-swatch ${kind}`); swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, el("span", "", label), el("strong", "", `€${Number(value).toLocaleString("en-US")}`));
    key.append(item);
  });
  figure.append(bar, key);
  return figure;
}
function progressHeader() {
  const header = el("header", "paper-masthead");
  const brand = el("div", "paper-brand");
  const logo = document.createElement("img"); logo.src = "/mantu-icon.svg"; logo.alt = "Mantu"; logo.width = 38; logo.height = 38;
  brand.append(logo, el("span", "", "Financial assessment"), el("span", "paper-practice-tag", "PRACTICE"));
  const rail = el("div", "practice-progress-shell");
  const progress = el("progress", "practice-progress"); progress.id = "practice-progress"; progress.max = total; progress.value = answeredCount();
  progress.setAttribute("aria-label", "Questions answered");
  const labels = el("div", "practice-progress-labels");
  const count = el("span", "practice-answered"); count.id = "practice-answered"; count.textContent = `${answeredCount()} of ${total} answered`;
  const pct = el("span", "practice-percent"); pct.id = "practice-percent"; pct.textContent = `${Math.round(answeredCount() / total * 100)}%`;
  labels.append(count, pct); rail.append(progress, labels);
  header.append(brand, rail);
  return header;
}
function timerRow() {
  const row = el("div", "practice-timer-row");
  const label = el("span", "timer-label", "Time remaining");
  label.id = "practice-timer-label";
  const time = el("time", "practice-timer", "15:00");
  time.id = "practice-timer";
  time.setAttribute("role", "timer");
  time.setAttribute("aria-labelledby", label.id);
  const status = el("span", "visually-hidden");
  status.id = "practice-timer-status";
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  row.append(label, time, el("span", "timer-note", "Answers stay in this tab until you submit"), status);
  return row;
}
function cuePracticeTimer(seconds) {
  const status = $("practice-timer-status");
  if (!status) return;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  let cue = "";
  if (seconds <= 0) cue = "Practice time has ended.";
  else if (seconds <= 120) cue = `Two minutes or less remain. ${clock} left.`;
  else if (!practiceTimerCue) cue = `Time remaining ${clock}.`;
  if (!cue || cue === practiceTimerCue) return;
  practiceTimerCue = cue;
  status.textContent = cue;
}
function updateProgress() {
  const count = answeredCount();
  const progress = $("practice-progress");
  if (progress) progress.value = count;
  const countLabel = $("practice-answered");
  if (countLabel) countLabel.textContent = `${count} of ${total} answered`;
  const pctLabel = $("practice-percent");
  if (pctLabel) pctLabel.textContent = `${Math.round(count / total * 100)}%`;
  const submit = $("practice-submit");
  if (submit) submit.disabled = count !== total || submissionPending;
  if (progress) progress.style.setProperty("--progress", `${count / total * 100}%`);
  updateQuestionNavigation();
}
function renderQuestion(question, index) {
  const card = el("article", "practice-question-card");
  card.dataset.questionId = question.id;
  card.id = `practice-question-${index + 1}`;
  const head = el("div", "question-head");
  const number = el("span", "practice-question-number", String(index + 1).padStart(2, "0"));
  const body = el("div", "question-body");
  body.append(el("p", "question-section", index < 8 ? "FOUNDATIONS" : "APPLIED READING"));
  const title = el("h3", "practice-question-prompt", question.prompt);
  title.id = `practice-prompt-${index + 1}`;
  title.tabIndex = -1;
  body.append(title);
  if (question.usesReferenceTable && referenceTable) {
    const cue = el("a", "reference-cue", "View the monthly portfolio P&L");
    cue.href = "#practice-reference-table";
    body.append(cue);
  }
  head.append(number, body); card.append(head);
  if (question.table) card.append(renderTable(question.table, "Comparison figures"));
  const fieldset = el("fieldset", "practice-options");
  fieldset.setAttribute("aria-describedby", title.id);
  fieldset.append(el("legend", "visually-hidden", `Question ${index + 1}: choose one answer`));
  question.options.forEach((option, choiceIndex) => {
    const label = el("label", "practice-option");
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = `answer-${question.id}`; radio.value = option.id;
    radio.checked = answers[question.id] === option.id;
    radio.addEventListener("change", () => {
      answers[question.id] = option.id;
      currentQuestionIndex = index;
      stickyQuestionIndex = index;
      updateProgress();
      card.classList.add("answered");
    });
    const letter = el("span", "option-letter", String.fromCharCode(65 + choiceIndex));
    label.append(radio, letter, el("span", "option-text", option.text));
    fieldset.append(label);
  });
  card.append(fieldset);
  return card;
}
function partHeader(part, title, detail) {
  const node = el("header", "practice-part-header");
  node.dataset.part = part;
  node.append(el("span", "part-kicker", detail), el("h2", "", title));
  return node;
}
function questionMatchesFilter(index) {
  if (activeFilter === "all") return true;
  const answered = Boolean(answers[questions[index]?.id]);
  return (activeFilter === "answered" && answered) || (activeFilter === "unanswered" && !answered);
}
function updateQuestionNavigation() {
  const count = answeredCount();
  const counts = { all: questions.length, answered: count, unanswered: questions.length - count };
  document.querySelectorAll("[data-practice-filter]").forEach((control) => {
    const filter = control.dataset.practiceFilter;
    control.setAttribute("aria-pressed", String(filter === activeFilter));
    const label = control.querySelector("[data-filter-count]");
    if (label) label.textContent = String(counts[filter]);
  });
  const jump = $("practice-jump");
  if (jump) {
    const selected = String(currentQuestionIndex);
    if (jump.value !== selected) jump.value = selected;
  }
  const shown = [];
  document.querySelectorAll(".practice-question-card").forEach((card, index) => {
    const keepFocused = index === stickyQuestionIndex;
    const visible = questionMatchesFilter(index) || keepFocused;
    card.hidden = !visible;
    if (visible) shown.push(index);
    const navItem = document.querySelector(`[data-nav-question="${index}"]`);
    if (navItem) {
      navItem.classList.toggle("is-answered", Boolean(answers[questions[index]?.id]));
      navItem.setAttribute("aria-current", index === currentQuestionIndex ? "step" : "false");
      navItem.disabled = !visible;
    }
  });
  document.querySelectorAll(".practice-part-header").forEach((heading) => {
    const first = heading.dataset.part === "foundations" ? 0 : 8;
    const last = heading.dataset.part === "foundations" ? 7 : 14;
    heading.hidden = !shown.some((index) => index >= first && index <= last);
  });
  const reference = $("practice-reference-table");
  if (reference) reference.hidden = !(activeFilter === "all" || shown.some((index) => index >= 8 && index <= 12));
  const empty = $("practice-filter-empty");
  if (empty) {
    empty.hidden = shown.length > 0;
    const message = empty.querySelector("span");
    if (shown.length === 0 && message) message.textContent = "No questions in this filter.";
  }
  const navCount = $("practice-nav-count");
  if (navCount) navCount.textContent = `${count} of ${questions.length} answered`;
}
function navigateToQuestion(index) {
  if (!Number.isInteger(index) || index < 0 || index >= questions.length) return;
  if (!questionMatchesFilter(index)) {
    activeFilter = "all";
  }
  stickyQuestionIndex = index;
  currentQuestionIndex = index;
  updateQuestionNavigation();
  const card = document.getElementById(`practice-question-${index + 1}`);
  card?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  card?.querySelector(".practice-question-prompt")?.focus({ preventScroll: true });
}
function practiceNavigation() {
  const nav = el("aside", "practice-nav"); nav.id = "practice-nav";
  nav.setAttribute("aria-label", "Question navigation");
  nav.append(el("p", "nav-heading", "YOUR PAPER"));
  const navCount = el("p", "practice-nav-count", "0 of 15 answered"); navCount.id = "practice-nav-count"; nav.append(navCount);
  const jumpLabel = el("label", "jump-label", "Jump to question"); jumpLabel.htmlFor = "practice-jump";
  const jump = el("select", "practice-jump"); jump.id = "practice-jump";
  questions.forEach((question, index) => {
    const option = el("option", "", `Question ${String(index + 1).padStart(2, "0")}`); option.value = String(index); jump.append(option);
  });
  jump.addEventListener("change", () => navigateToQuestion(Number(jump.value)));
  nav.append(jumpLabel, jump);
  const filters = el("div", "practice-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Filter questions by answer status");
  [["all", "All"], ["answered", "Answered"], ["unanswered", "Unanswered"]].forEach(([filter, label]) => {
    const control = button("", "practice-filter", () => { activeFilter = filter; stickyQuestionIndex = -1; updateQuestionNavigation(); });
    control.dataset.practiceFilter = filter;
    control.append(el("span", "", label), el("span", "filter-count", "15")); control.lastChild.dataset.filterCount = "";
    filters.append(control);
  });
  nav.append(filters);
  const list = el("div", "practice-nav-list");
  questions.forEach((question, index) => {
    const item = button(String(index + 1).padStart(2, "0"), "practice-nav-question", () => navigateToQuestion(index));
    item.dataset.navQuestion = String(index); item.setAttribute("aria-label", `Go to question ${String(index + 1).padStart(2, "0")}`);
    list.append(item);
  });
  nav.append(list);
  const empty = el("p", "practice-filter-empty"); empty.id = "practice-filter-empty"; empty.hidden = true; empty.setAttribute("role", "status");
  empty.append(el("span", "", "No questions in this filter."), button("Show all questions", "text-action", () => { activeFilter = "all"; stickyQuestionIndex = -1; updateQuestionNavigation(); }));
  nav.append(empty);
  return nav;
}
function renderPaper(focus = false) {
  if (serverTime() >= deadline) return expirePractice();
  phase = "paper";
  showWorkspace();
  const shell = el("div", "practice-paper-shell");
  shell.id = "practice-assessment";
  shell.append(progressHeader(), timerRow());
  const frame = el("div", "practice-paper-frame");
  const paper = el("div", "practice-paper");
  const intro = el("section", "paper-instructions");
  intro.append(el("p", "eyebrow", "15 QUESTIONS · 15 MINUTES"), el("p", "", "Choose one answer for every question. You can change selections anywhere on this page before submitting. Calculator use is fine."));
  paper.append(intro, partHeader("foundations", "Part 1 · Foundations", "01 — 08"));
  questions.slice(0, 8).forEach((q, i) => paper.append(renderQuestion(q, i)));
  paper.append(partHeader("applied", "Part 2 · Applied Reading", "09 — 15"));
  if (referenceTable) {
    const reference = el("section", "portfolio-reference"); reference.id = "practice-reference-table";
    reference.append(el("p", "eyebrow", "BUSINESS MANAGER’S MONTHLY PORTFOLIO"), portfolioViz(referenceTable), renderTable(referenceTable, "Monthly portfolio P&L"));
    paper.append(reference);
  }
  questions.slice(8).forEach((q, i) => paper.append(renderQuestion(q, i + 8)));
  const finish = el("section", "practice-finish");
  finish.append(el("p", "finish-note", "Review the full paper above. Your answers are sent for scoring only when you finish."));
  const submit = button("Submit practice assessment", "button primary finish-practice", confirmFinish);
  submit.id = "practice-submit"; submit.disabled = true;
  finish.append(submit, el("p", "finish-privacy", "Practice score is private feedback. It is not sent to recruiters or used for hiring."));
  paper.append(finish);
  frame.append(practiceNavigation(), paper);
  shell.append(frame);
  panel.replaceChildren(shell);
  const portfolio = $("practice-reference-table");
  if (portfolio) {
    if ("IntersectionObserver" in window) {
      const reveal = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          portfolio.classList.add("is-visible");
          reveal.disconnect();
        }
      }, { threshold: 0.18 });
      reveal.observe(portfolio);
    } else portfolio.classList.add("is-visible");
  }
  updateProgress();
  updateClock();
  if (focus) { const heading = shell.querySelector(".practice-question-prompt"); heading?.focus({ preventScroll: true }); }
}
function bandFor(value) {
  if (value >= 13) return "Excellent";
  if (value >= 10) return "Good";
  if (value >= 7) return "Average";
  return "Insufficient";
}
function confirmFinish() {
  if (answeredCount() !== questions.length || submissionPending) return;
  const title = el("h2", "", "Submit your practice paper?"); title.id = "dialog-title";
  const content = el("p", "body-copy", "Your answers will be scored for your own practice. The result is not used for hiring.");
  const actions = el("div", "action-row");
  actions.append(button("Keep reviewing", "button secondary", () => dialog.close()), button("Submit and see score", "button primary", async () => { dialog.close(); await submitPractice(); }));
  $("dialog-body").replaceChildren(title, content, actions);
  dialog.showModal(); title.focus({ preventScroll: true });
}
async function submitPractice() {
  if (submissionPending || !challenge || phase !== "paper") return;
  if (serverTime() >= deadline) return expirePractice();
  const version = requestVersion;
  submissionPending = true; updateProgress(); showStatus("Sending your answers for practice scoring…");
  try {
    const result = await api("submit", { challenge, answers: { ...answers } });
    if (version !== requestVersion) return;
    if (!Number.isSafeInteger(result.score) || !Number.isSafeInteger(result.total) || result.total !== questions.length ||
        !Number.isSafeInteger(result.answered) || !Number.isFinite(result.submittedAt) || result.score < 0 || result.score > result.total || result.answered !== questions.length) {
      throw new Error("The practice score could not be confirmed. Try again.");
    }
    score = result.score; total = result.total; resultAnswered = result.answered;
    clockBase = { server: result.submittedAt, local: performance.now() };
    resultUntil = result.submittedAt + 30 * 60 * 1000;
    questions = []; referenceTable = null; answers = Object.create(null); challenge = ""; deadline = 0;
    phase = "result"; submissionPending = false; clearStatus(); renderResult();
  } catch (error) {
    if (version !== requestVersion) return;
    submissionPending = false;
    if (clockBase && serverTime() >= deadline) return expirePractice();
    updateProgress(); showStatus(error.message || "The practice score could not be confirmed. Your answers remain in this page. Try again.");
  }
}
function renderResult() {
  phase = "result"; showWorkspace();
  const card = el("section", "practice-result");
  card.id = "practice-results";
  card.setAttribute("aria-labelledby", "practice-results-heading");
  const top = el("header", "result-header");
  top.append(el("p", "eyebrow", "PRIVATE PRACTICE FEEDBACK"));
  const heading = el("h1", "", "Your practice result");
  heading.id = "practice-results-heading";
  heading.tabIndex = -1;
  top.append(heading);
  const layout = el("div", "result-dashboard");
  const scorePanel = el("section", "result-score-panel"); scorePanel.setAttribute("aria-label", "Your practice score");
  const activeBand = bandFor(score);
  const circle = el("div", "score-circle");
  circle.id = "practice-score-figure";
  circle.setAttribute("role", "img");
  circle.setAttribute("aria-label", `${score} out of ${total}, ${activeBand} band`);
  heading.setAttribute("aria-describedby", circle.id);
  const scoreText = el("strong", "score-value", String(score));
  const divider = el("span", "score-divider", "/");
  const scoreTotal = el("span", "score-total", String(total));
  scoreText.setAttribute("aria-hidden", "true");
  divider.setAttribute("aria-hidden", "true");
  scoreTotal.setAttribute("aria-hidden", "true");
  circle.append(scoreText, divider, scoreTotal);
  circle.style.setProperty("--score-ratio", `${score / total}`);
  circle.style.setProperty("--score-turn", `${score / total * 360}deg`);
  const band = el("p", "result-band", activeBand); band.setAttribute("aria-live", "polite");
  const answered = el("p", "result-answered", `${resultAnswered} of ${total} answered`);
  scorePanel.append(circle, band, answered);
  const detailPanel = el("section", "result-detail-panel");
  const reflection = {
    Excellent: "Explain why the portfolio’s gross margin and operating contribution differ.",
    Good: "Practice next: connect revenue, direct costs, gross margin and overhead.",
    Average: "Practice next: work from revenue to direct costs, then gross margin.",
    Insufficient: "Take another run at your own pace, starting with revenue minus direct costs.",
  }[activeBand];
  detailPanel.append(el("p", "result-reflection", reflection));
  const bands = el("div", "score-bands");
  bands.setAttribute("role", "list");
  bands.setAttribute("aria-label", "Score bands");
  [["Excellent", "13–15"], ["Good", "10–12"], ["Average", "7–9"], ["Insufficient", "0–6"]].forEach(([name, range]) => {
    const item = el("div", "score-band");
    item.dataset.scoreBand = name.toLowerCase();
    item.setAttribute("role", "listitem");
    if (name === activeBand) { item.classList.add("is-active"); item.setAttribute("aria-current", "true"); }
    item.append(el("strong", "", name), el("span", "", range));
    bands.append(item);
  });
  detailPanel.append(bands);
  layout.append(scorePanel, detailPanel);
  const actions = el("div", "result-actions");
  actions.append(button("Retake practice assessment", "button primary", start), button("Back to overview", "button secondary", () => { clearPractice(); phase = "idle"; showHome(); }));
  card.append(top, layout, el("p", "result-copy", "This practice score is shown only here. It is not a hiring assessment and is not shared with recruiters."), actions);
  panel.replaceChildren(card);
  window.scrollTo({ top: 0, behavior: "instant" });
  heading.focus({ preventScroll: true });
}
function expirePractice() {
  if (phase === "expired" || phase === "idle") return;
  clearPractice(); phase = "expired"; showWorkspace();
  const card = el("section", "practice-expired");
  const heading = el("h1", "", "Practice time ended");
  heading.tabIndex = -1;
  card.append(heading, el("p", "body-copy", "Your answers and practice challenge have been cleared. Start a new practice assessment whenever you are ready."), button("Start a new practice assessment", "button primary", start), button("Back to overview", "button secondary", () => { phase = "idle"; showHome(); }));
  panel.replaceChildren(card); heading.focus({ preventScroll: true });
}
function updateClock() {
  if ((phase === "paper" || phase === "submitting") && clockBase && serverTime() >= deadline) { expirePractice(); return; }
  if (phase === "result" && resultUntil && serverTime() >= resultUntil) {
    clearPractice(); phase = "expired"; showWorkspace();
    const cleared = el("section", "practice-expired");
    cleared.setAttribute("role", "status");
    const clearedHeading = el("h1", "", "Practice score cleared");
    clearedHeading.tabIndex = -1;
    cleared.append(clearedHeading, el("p", "body-copy", "Your practice score has been cleared."), button("Start a new practice assessment", "button primary", start));
    panel.replaceChildren(cleared);
    clearedHeading.focus({ preventScroll: true });
    return;
  }
  const timer = $("practice-timer");
  if (timer && clockBase && deadline && phase === "paper") {
    const seconds = remainingSeconds();
    timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    timer.classList.toggle("ending", seconds <= 120);
    cuePracticeTimer(seconds);
  }
}
window.addEventListener("assessment:practice-start", showPreflight);
window.addEventListener("assessment:practice-clear", () => { clearPractice(); phase = "idle"; });
document.addEventListener("visibilitychange", () => { if (!document.hidden) updateClock(); });
window.addEventListener("pageshow", updateClock);
observeLandingLedger();
setInterval(updateClock, 1000);
