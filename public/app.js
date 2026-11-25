const $ = (id) => document.getElementById(id);
const panel = $("workspace");
const dialog = $("dialog");
const claimPrefix = "mantu-assessment-claim:";
let explicitInvitation = typeof window.assessmentInvitation === "string";
let invite = window.assessmentInvitation || "";
delete window.assessmentInvitation;
let config, invitation, attempt, clockBase, claim, claimKey, claimVersion;
let claimCopyShortcutReview = false;
let claimIntegrityReview = false;
let initializing = true;
let configFailed = false;
let view = "landing";
let current = 0;
let draft = null;
let saving = false;
let submitting = false;
let startPending = false;
let claimExpiry = 0;
let deadlineCheck = false;
let bannerOnError = "";
let bootstrapVersion = 0;
let candidateEpoch = 0;
let copyShortcutListenerAttached = false;
const copySignalReported = new Set();
const copySignalPending = new Set();
const integrityReported = new Map([['copy', new Set()], ['contextMenu', new Set()], ['pageHidden', new Set()]]);
const integrityPending = new Set();
const sessionChannel = "BroadcastChannel" in window
  ? new BroadcastChannel("assessment-session-v1")
  : null;

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
function setFocus(node) {
  if (!node) return;
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
}
function switchView(next) {
  const changed = view !== next;
  view = next;
  syncCopyShortcutListener();
  $("landing").hidden = next !== "landing";
  $("outline").hidden = next !== "landing";
  panel.hidden = next === "landing";
  panel.replaceChildren();
  $("system-status").replaceChildren();
  if (changed) window.scrollTo({ top: 0, behavior: "instant" });
}
function showStatus(message, recovery) {
  const box = $("system-status");
  box.replaceChildren(el("span", "", message));
  if (recovery) box.append(button("Try again", "text-action", recovery));
}
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
async function api(path, method = "GET", body, expectedReference) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/api/" + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(expectedReference ? { "X-Assessment-Reference": expectedReference } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ApiError(
        typeof result.error === "string"
          ? result.error
          : "The request could not be completed.",
        response.status,
      );
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "We could not connect. Check your connection and try again.",
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
}
async function fingerprint(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
// Only a previously verified history entry may resume on refresh with its host cookie.
async function rememberHistory() {
  const active = attempt;
  if (!active) return;
  const check = await fingerprint(active.reference);
  if (attempt === active)
    history.replaceState(
      {
        check,
        reference: active.reference,
        until: Date.now() + Math.max(0, active.purgeAt - serverTime()),
      },
      "",
      "",
    );
}
function receive(data, expected = attempt?.reference) {
  if (data?.attempt === undefined)
    throw new Error("The assessment service returned an incomplete response.");
  if (expected && (!data.attempt || data.attempt.reference !== expected)) {
    const message =
      "This tab can no longer access that assessment. Open your personal invitation in a private browsing window.";
    clearCandidateState(message);
    throw new ApiError(message, 409);
  }
  if (attempt?.reference !== data.attempt?.reference) {
    copySignalReported.clear();
    copySignalPending.clear();
    for (const ids of integrityReported.values()) ids.clear();
    integrityPending.clear();
  }
  attempt = data.attempt;
  syncCopyShortcutListener();
  if (attempt)
    clockBase = {
      server: data.serverNow ?? Date.now(),
      local: performance.now(),
    };
}
function integrityMode(notice) {
  if (notice?.integrityReview === true) return "integrity";
  if (notice?.copyShortcutReview === true) return "legacy";
  return "off";
}
function serverTime() {
  return clockBase.server + performance.now() - clockBase.local;
}
function dateTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}
function getClaim(noticeVersion) {
  const mode = integrityMode(invitation?.notice);
  if (claim && (claimVersion !== noticeVersion || claimCopyShortcutReview !== (mode === "legacy") || claimIntegrityReview !== (mode === "integrity"))) clearClaim();
  if (claim) return claim;
  if (!/^[a-f0-9]{64}$/.test(claim || "")) {
    claim = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    claimVersion = noticeVersion;
    claimCopyShortcutReview = mode === "legacy";
    claimIntegrityReview = mode === "integrity";
    claimExpiry = invitation?.hardEnd ?? Date.now() + 60 * 60 * 1000;
    try {
      sessionStorage.setItem(
        claimKey,
        JSON.stringify({ claim, version: noticeVersion, expires: claimExpiry,
          ...(claimIntegrityReview ? { integrityReview: true } : claimCopyShortcutReview ? { copyShortcutReview: true } : {}) }),
      );
    } catch {
      /* Keep the temporary claim in memory. */
    }
  }
  return claim;
}
async function prepareClaimKey() {
  claimKey = claimPrefix + (await fingerprint(invite));
  try {
    const stored = JSON.parse(sessionStorage.getItem(claimKey));
    if (
      stored &&
      stored.expires > Date.now() &&
      /^[a-f0-9]{64}$/.test(stored.claim) &&
      typeof stored.version === "string"
    ) {
      claim = stored.claim;
      claimVersion = stored.version;
      claimCopyShortcutReview = stored.copyShortcutReview === true;
      claimIntegrityReview = stored.integrityReview === true;
      claimExpiry = stored.expires;
    } else clearClaim();
  } catch {
    clearClaim();
  }
}
function clearClaim() {
  if (claimKey) {
    try {
      sessionStorage.removeItem(claimKey);
    } catch {
      /* Private sessions may block storage. */
    }
  }
  claim = null;
  claimVersion = null;
  claimCopyShortcutReview = false;
  claimIntegrityReview = false;
  claimExpiry = 0;
}
function clearCandidateState(message, { broadcast = false } = {}) {
  candidateEpoch++;
  attempt = null;
  copySignalReported.clear();
  copySignalPending.clear();
  for (const ids of integrityReported.values()) ids.clear();
  integrityPending.clear();
  invitation = null;
  draft = null;
  saving = false;
  submitting = false;
  startPending = false;
  deadlineCheck = false;
  invite = "";
  explicitInvitation = false;
  if (dialog.open) dialog.close();
  $("dialog-body").replaceChildren();
  clearClaim();
  history.replaceState(null, "", "");
  bannerOnError = message || "";
  if (broadcast) sessionChannel?.postMessage({ type: "invitation-changed" });
  if (configFailed) configFailed = false;
  landing(Boolean(message));
}
function currentResponse(data, expectedReference, epoch) {
  if (epoch !== candidateEpoch) return false;
  if (attempt && expectedReference && attempt.reference !== expectedReference)
    return false;
  if (!data?.attempt || data.attempt.reference !== expectedReference) {
    clearCandidateState(
      "This browser is now connected to a different invitation. Open your personal link to continue.",
    );
    return false;
  }
  return true;
}
async function scopedSession(reference, epoch = candidateEpoch) {
  const data = await api("session", "GET", undefined, reference);
  if (!currentResponse(data, reference, epoch)) return null;
  receive(data, reference);
  return data;
}
function dialogContent(title, contents, actions) {
  const body = $("dialog-body");
  const header = el("h2", "", title);
  header.id = "dialog-title";
  body.replaceChildren(header, ...contents);
  const controls = el("div", "action-row");
  controls.append(
    ...(actions || [button("Close", "button secondary", () => dialog.close())]),
  );
  body.append(controls);
  if (!dialog.open) dialog.showModal();
  setFocus(header);
}
function definitionList(entries) {
  const list = el("dl", "details-list");
  for (const [label, value] of entries.filter(
    ([, value]) => value !== "" && value !== null && value !== undefined,
  )) {
    list.append(
      el("dt", "", label),
      el("dd", "", Array.isArray(value) ? value.join(" ") : String(value)),
    );
  }
  return list;
}
function privacyContent() {
  const notice = invitation?.notice ?? attempt?.notice ?? config?.notice;
  const recruitmentContext = Boolean(invite || invitation || attempt);
  const intro = el(
    "p",
    "body-copy",
    recruitmentContext
      ? "This recruitment assessment is governed by the country privacy notice below. The public practice privacy description does not apply to this invitation. The service also receives connection metadata, such as IP address and request timing, to deliver and protect the site."
      : "The anonymous practice assessment uses synthetic financial questions. Before you submit, answers and progress stay in this tab's memory and are not written to browser storage. If you submit, the service checks your answers and returns only your score; it does not save a practice record or share the score with recruiters. The service receives connection metadata, such as IP address and request timing, to deliver and protect the site. A recruitment invitation starts a separate process with its own privacy notice and retention rules.",
  );
  const groupContact = el(
    "p",
    "body-copy",
    "Mantu Group’s data protection contact is personaldata@mantu.com. ",
  );
  const source = el("a", "", "Mantu careers privacy policy");
  source.href = "https://careers.mantu.com/privacy-policy";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  groupContact.append(source);
  if (!notice?.controller)
    return [
      intro,
      groupContact,
      el(
        "p",
        "notice",
        config?.enabled
          ? "Your personal invitation includes the recruitment privacy notice for your country. Open it to see the controller, privacy contact and your rights."
          : "Recruitment invitations are unavailable until the recruitment privacy notice is configured.",
      ),
    ];
  return [
    intro,
    groupContact,
    definitionList([
      ["Controller", notice.controller],
      ["Privacy contact", notice.contact],
      ["Purpose", notice.purpose],
      ["Legal basis", notice.basis],
      [
        "Assessment records",
        "Candidate reference, assigned questions, saved answers, assessment times and result.",
      ],
      ["Recipients", notice.recipients],
      [
        "Retention",
        "Editing stops at the assessment deadline. After submission, the record cutoff is the earlier of 30 minutes after submission or 60 minutes after invitation creation. For an incomplete attempt, it is the earlier of 30 minutes after the assessment deadline or 60 minutes after invitation creation. An unused invitation is purged at its start-by expiry. The service schedules deletion; physical media, replicas, logs and request metadata may persist longer.",
      ],
      ["Transfers", notice.transfers],
      ["Your rights", notice.rights],
      ["Supervisory authority", notice.supervisoryAuthority],
      ["Notice version", notice.version],
      ...(notice.copyShortcutReview === true
        ? [["Copy-shortcut review signal", copyShortcutDisclosureText()]]
        : notice.integrityReview === true
          ? [["Assessment integrity observations", integrityDisclosureText()]]
        : []),
    ]),
  ];
}
function landing(focus = false) {
  switchView("landing");
  const recruitmentLink = Boolean(explicitInvitation || invite || invitation);
  $("practice-intro").querySelector(".welcome-kicker").textContent = recruitmentLink ? "Recruitment invitation" : "Anonymous practice";
  $("welcome-description").textContent = recruitmentLink
    ? "Your personal recruitment invitation is ready for review. The country privacy notice applies before you start."
    : "A practical assessment of financial foundations and portfolio performance.";
  const facts = $("practice-intro").querySelector(".welcome-facts");
  facts.replaceChildren(...(recruitmentLink
    ? ["Use the personal link supplied by your recruiter", "The country privacy notice applies", "Review answers before final submission"]
    : ["Calculator use is fine", "Review and change answers before submitting", "No name or sign-in required"]
  ).map((text) => el("li", "", text)));
  $("welcome-privacy").textContent = recruitmentLink
    ? "This invitation starts a recruitment assessment. Read the country privacy notice before you begin; it explains how your answers are used and retained."
    : "Answers stay in this tab until submission. The service returns a private practice score and does not save a practice record.";
  const ledgerPill = $("landing").querySelector(".ledger-pill");
  if (ledgerPill) ledgerPill.textContent = "EXAMPLE PORTFOLIO";
  const beforeCopy = $("landing").querySelector(".studio-before-copy");
  if (beforeCopy) beforeCopy.textContent = recruitmentLink
    ? `This invitation contains 15 questions. Your time allowance is confirmed below before you start. You may use a calculator and review every answer before submitting.`
    : "Two parts move from financial foundations to portfolio decisions. Allow 15 minutes, use a calculator if helpful, and review every answer before you submit.";
  const beforePrivacy = $("landing").querySelector(".studio-before-privacy");
  if (beforePrivacy) beforePrivacy.textContent = recruitmentLink
    ? "Recruitment answers are handled under the country notice shown before start. Your invitation has its own time allowance and retention period. The service also receives technical request metadata to deliver and protect the site."
    : "Practice answers stay in this tab until you submit. Scoring returns only your private feedback; no practice record is saved. Recruitment invitations use a separate private flow.";
  const scope = $("landing").querySelector(".welcome-scope");
  if (recruitmentLink) scope.textContent = invitation?.durationMinutes
    ? `15 questions · ${invitation.durationMinutes} minutes`
    : "Personal invitation · time allowance confirmed before start";
  else scope.textContent = "15 questions · 15 minutes";
  const trigger = $("landing-action");
  trigger.className = "button primary start-practice";
  const canStart = Boolean(invite && config?.enabled && invitation);
  const waiting = Boolean(invite && initializing);
  trigger.disabled = waiting;
  trigger.replaceChildren(
    document.createTextNode(
      canStart
        ? "Review your invitation "
        : waiting
          ? "Checking invitation "
          : "Start practice assessment ",
    ),
    el("span", "", canStart ? "→" : "↗"),
  );
  trigger.lastChild.setAttribute("aria-hidden", "true");
  trigger.onclick = () => {
    if (canStart) preflight();
    else if (!waiting) window.dispatchEvent(new Event("assessment:practice-start"));
  };
  const sampleAction = $("sample-action");
  if (sampleAction) {
    sampleAction.hidden = canStart || waiting;
    sampleAction.onclick = sample;
  }
  const minutes = invitation?.durationMinutes ?? config?.durationMinutes;
  $("hero-time").hidden = !Number.isFinite(minutes) || (invite && !invitation);
  if (!$("hero-time").hidden) $("hero-time").textContent = minutes + " min";
  $("hero-hint").textContent = canStart
    ? "Your timer starts when you confirm on the next screen."
    : recruitmentLink
      ? "This page is checking your invitation. Review its country privacy notice before starting."
      : "Have a recruitment invitation? Open the personal link from your recruiter.";
  if (bannerOnError)
    showStatus(bannerOnError, configFailed ? bootstrap : undefined);
  if (focus) setFocus($("landing-title"));
}
function copyShortcutDisclosureText() {
  return "When selected text inside an active question is copied with the Ctrl/Cmd+C shortcut, the question identifier may be recorded for human review. The selected text and clipboard contents are not collected. This signal alone cannot establish outside assistance or trigger an automatic hiring decision. You may still select text, use a calculator, and use keyboard or accessibility aids.";
}
function integrityDisclosureText() {
  return "During an active scored question, the service may count distinct questions where a native copy event occurred on selected question text, a context menu was opened on question content, or the assessment page became hidden. The server also counts distinct questions with submitted answer choices that were not assigned. That can reflect a technical error. These categories can overlap; calculators, accessibility tools and ordinary browser menus can explain observations. Only authorized reviewers see the counts after the assessment closes. Counts are reviewed by a person, may be incomplete, and cannot establish outside assistance. No text, clipboard contents, focus changes, timing history or application details are collected, and no automatic hiring decision is made.";
}
function sample() {
  switchView("sample");
  const card = el("section", "content-card narrow");
  const heading = el("h1", "", "Try a sample question");
  const form = el("form", "");
  const question = el(
    "h2",
    "",
    "A project has an €800 travel allowance. The team spends €525. How much remains?",
  );
  question.id = "sample-prompt";
  const set = el("fieldset", "option-set");
  set.append(el("legend", "", "Choose one answer."));
  const feedback = el("p", "practice-feedback");
  feedback.setAttribute("role", "status");
  const choices = ["€225", "€275", "€325"];
  choices.forEach((text, index) => {
    const label = el("label", "option");
    const input = el("input");
    input.name = "sample";
    input.type = "radio";
    input.value = String(index);
    input.required = true;
    input.addEventListener("change", () => {
      feedback.textContent = "";
    });
    label.append(input, el("span", "", text));
    set.append(label);
  });
  const actions = el("div", "action-row");
  const check = el("button", "button primary", "Check answer");
  check.type = "submit";
  actions.append(
    check,
    button("Back to overview", "button secondary", () => landing(true)),
  );
  form.append(set, feedback, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    feedback.textContent =
      form.elements.sample.value === "1"
        ? "Correct. €800 minus €525 leaves €275."
        : "The remaining allowance is €275. Subtract the €525 spent from the original €800.";
  });
  card.append(
    el("p", "eyebrow", "Practice"),
    heading,
    el(
      "p",
      "body-copy",
      "This example is unscored. Your answer stays in this browser tab.",
    ),
    question,
    form,
  );
  panel.append(card);
  setFocus(heading);
}
function preflight() {
  switchView("preflight");
  const card = el("section", "content-card narrow");
  const heading = el("h1", "", "Before you start");
  const form = el("form");
  const directions = el(
    "p",
    "body-copy",
    "Complete the assessment independently, without outside help. You may use a calculator and the supplied tables. You can revisit any saved answer before submitting or before time runs out.",
  );
  const duration = invitation?.durationMinutes;
  const details = definitionList([
    ["Assessment", "15 questions across 2 sections"],
    [
      "How answers are used",
      "The app scores submitted answers against an answer key. A recruiter reviews the result as part of the hiring process. The app makes no hiring decision.",
    ],
    [
      "Country for this invitation",
      invitation?.country
        ? new Intl.DisplayNames(["en"], { type: "region" }).of(
            invitation.country,
          )
        : null,
    ],
    [
      "Invitation expires",
      invitation?.expiresAt ? dateTime(invitation.expiresAt) : null,
    ],
    [
      "Time available",
      duration
        ? duration + " minutes from the moment you start"
        : "Use the duration shown in your invitation.",
    ],
    [
      "Access or adjustments",
      "Contact your recruiter before starting if you need more time or an accessible alternative.",
    ],
  ]);
  const legal = el("details", "privacy-detail");
  legal.append(
    el("summary", "", "Recruitment privacy notice"),
    ...privacyContent(),
  );
  const ack = el("label", "ack");
  const input = el("input");
  input.type = "checkbox";
  input.required = true;
  ack.append(
    input,
    el(
      "span",
      "",
      invitation?.notice?.integrityReview === true
        ? "I have read how this assessment works and how these observations are reviewed."
        : "I have read the assessment instructions and privacy notice.",
    ),
  );
  const actions = el("div", "action-row");
  const start = el("button", "button primary", "Start assessment");
  start.type = "submit";
  actions.append(
    start,
    button("Back", "button secondary", () => landing(true)),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (startPending || !input.checked) return;
    startPending = true;
    start.disabled = true;
    start.textContent = "Starting…";
    try {
      const expectedReference = invitation.reference;
      const epoch = candidateEpoch;
      const noticeVersion = invitation.notice.version;
      const claimValue = getClaim(noticeVersion);
      const data = await api("start", "POST", {
          invite,
          noticeVersion,
          claim: claimValue,
          ...(claimIntegrityReview ? { integrityReview: true } : claimCopyShortcutReview ? { copyShortcutReview: true } : {}),
        });
      if (epoch !== candidateEpoch) return;
      if (!data?.attempt || data.attempt.reference !== expectedReference) {
        clearCandidateState("The invitation changed. Reopen your personal link to continue.");
        return;
      }
      receive(data, expectedReference);
      if (!attempt) throw new Error("Your assessment could not be opened.");
      await rememberHistory();
      clearClaim();
      sessionChannel?.postMessage({ type: "invitation-changed", reference: expectedReference });
      explicitInvitation = false;
      invite = "";
      invitation = null;
      resume();
    } catch (error) {
      showStatus(
        error.status === 0
          ? "The start request could not be confirmed. Try Start assessment again here, or reopen the original invitation in this tab."
          : error.message,
      );
    } finally {
      startPending = false;
      start.disabled = false;
      start.textContent = "Start assessment";
    }
  });
  form.append(legal, ack, actions);
  card.append(
    el("p", "eyebrow", "Personal invitation"),
    heading,
    directions,
    ...(invitation?.notice?.copyShortcutReview === true
      ? [el("p", "notice copy-shortcut-notice", copyShortcutDisclosureText())]
      : invitation?.notice?.integrityReview === true
        ? [el("p", "notice integrity-notice", integrityDisclosureText())]
      : []),
    details,
    form,
  );
  panel.append(card);
  setFocus(heading);
}
function resume() {
  if (!attempt) {
    landing(true);
    return;
  }
  if (attempt.status !== "active") {
    terminal();
    return;
  }
  current = Math.max(
    0,
    attempt.questions.findIndex((q) => !attempt.answers[q.id]?.length),
  );
  questionView(true);
}
function countAnswers() {
  return attempt.questions.filter(
    (q) => Array.isArray(attempt.answers[q.id]) && attempt.answers[q.id].length,
  ).length;
}
function timeLeft() {
  return Math.max(0, Math.ceil((attempt.deadline - serverTime()) / 1000));
}
function updateClock() {
  if (claim && claimExpiry && Date.now() >= claimExpiry) clearClaim();
  if (
    invitation?.expiresAt &&
    serverTime() >= invitation.expiresAt &&
    !startPending
  ) {
    invitation = null;
    invite = "";
    clearClaim();
    if (dialog.open) dialog.close();
    bannerOnError =
      "This invitation has expired. Ask your recruiter for a fresh invitation.";
    landing(true);
    return;
  }
  if (attempt?.purgeAt && serverTime() >= attempt.purgeAt) {
    clearCandidateState(
      "The access window for this assessment has ended. Its receipt is no longer available.",
      { broadcast: true },
    );
    return;
  }
  if (
    !attempt ||
    attempt.status !== "active" ||
    !["question", "review"].includes(view)
  )
    return;
  const clock = $("countdown");
  const seconds = timeLeft();
  if (clock) {
    clock.textContent =
      String(Math.floor(seconds / 60)).padStart(2, "0") +
      ":" +
      String(seconds % 60).padStart(2, "0");
    clock.parentElement.classList.toggle("ending", seconds <= 120);
  }
  if (seconds === 0 && !deadlineCheck) expireView();
}
function rail() {
  const box = el("aside", "rail");
  box.setAttribute("aria-label", "Assessment progress");
  const answered = el(
    "p",
    "answered-count",
    countAnswers() + " of " + attempt.questions.length + " answered",
  );
  answered.id = "answered-count";
  const progress = el("progress");
  progress.id = "answer-progress";
  progress.max = attempt.questions.length;
  progress.value = countAnswers();
  progress.setAttribute("aria-label", "Questions answered");
  const timer = el("p", "clock", "Time left ");
  const time = el("span");
  time.id = "countdown";
  time.setAttribute("role", "timer");
  timer.append(time);
  const link = button(
    view === "review" ? "Return to question" : "Review answers",
    "text-action",
    () => {
      if (draft || saving || submitting) return;
      if (view === "review") questionView(true);
      else review();
    },
  );
  link.id = "review-nav";
  link.disabled = Boolean(draft || saving || submitting);
  box.append(
    el("p", "section-legend", "Assessment"),
    el("h2", "", "Your progress"),
    answered,
    progress,
    timer,
    link,
  );
  return box;
}
function makeTable(table) {
  const wrapper = el("div", "table-scroll");
  const node = el("table");
  node.append(el("caption", "", "Reference figures"));
  const head = el("thead");
  const tr = el("tr");
  table.headers.forEach((text, index) => {
    const th = el("th", "", text || (index === 0 ? "Item" : "Value"));
    th.scope = "col";
    tr.append(th);
  });
  head.append(tr);
  const body = el("tbody");
  table.rows.forEach((row) => {
    const line = el("tr");
    row.forEach((text, index) => {
      const cell = el(index ? "td" : "th", "", text);
      if (!index) cell.scope = "row";
      line.append(cell);
    });
    body.append(line);
  });
  node.append(head, body);
  wrapper.append(node);
  return wrapper;
}
function questionView(focus = false) {
  switchView("question");
  const questions = attempt.questions;
  const question = questions[current];
  const frame = el("div", "work-frame");
  const card = el("article", "form-card");
  card.id = "active-question";
  const header = el("div", "card-header");
  const section = el("p", "eyebrow", question.section);
  const heading = el("h2", "", question.prompt);
  heading.id = "question-title";
  header.append(
    el("p", "q-num", "Question " + (current + 1) + " of " + questions.length),
    section,
  );
  card.append(header, heading);
  if (integrityMode(attempt.notice) !== "off") {
    const disclosure = el("details", "copy-shortcut-notice");
    const modern = integrityMode(attempt.notice) === "integrity";
    disclosure.append(el("summary", "", modern ? "Integrity observations notice" : "Copy-shortcut notice"), el("p", "body-copy", modern ? integrityDisclosureText() : copyShortcutDisclosureText()));
    card.append(disclosure);
  }
  if (question.table) card.append(makeTable(question.table));
  const choices = el("fieldset", "option-set");
  choices.id = "choices";
  choices.setAttribute("aria-describedby", "question-title");
  choices.append(
    el(
      "legend",
      "",
      question.multiple ? "Select all that apply." : "Choose one answer.",
    ),
  );
  const selected = draft?.choices ?? attempt.answers[question.id] ?? [];
  for (const option of question.options) {
    const label = el("label", "option");
    const input = el("input");
    input.name = "choice";
    input.value = option.id;
    input.type = question.multiple ? "checkbox" : "radio";
    input.checked = selected.includes(option.id);
    input.addEventListener("change", () => {
      draft = {
        questionId: question.id,
        choices: [...choices.querySelectorAll("input:checked")].map(
          (item) => item.value,
        ),
        phase: "new",
      };
      save();
    });
    label.append(input, el("span", "", option.text));
    choices.append(label);
  }
  const status = el("div", "save-line");
  status.id = "save-state";
  status.setAttribute("role", "status");
  const repair = el("div", "sync-actions");
  repair.id = "sync-actions";
  const controls = el("div", "card-actions");
  const previous = button("Previous", "button secondary", () => {
    if (current > 0) {
      current--;
      questionView(true);
    }
  });
  previous.id = "previous";
  const next = button(
    current === questions.length - 1 ? "Review answers" : "Next question →",
    "button primary",
    () => {
      if (current === questions.length - 1) review();
      else {
        current++;
        questionView(true);
      }
    },
  );
  next.id = "next";
  controls.append(previous, next);
  card.append(choices, status, repair, controls);
  if (attempt.notice?.integrityReview === true) {
    const localStatus = el("p", "integrity-local-status");
    localStatus.id = "integrity-local-status";
    localStatus.setAttribute("role", "status");
    card.append(localStatus);
    updateIntegrityLocalStatus();
  }
  frame.append(rail(), card);
  panel.append(frame);
  updateIntegrityLocalStatus();
  refreshSave();
  updateClock();
  if (focus && view === "question") setFocus(heading);
}
function refreshSave() {
  if (view !== "question") return;
  const locked = Boolean(draft || saving);
  $("choices").disabled = locked;
  $("review-nav").disabled = locked;
  $("next").disabled = locked;
  $("previous").disabled = locked || current === 0;
  $("answered-count").textContent =
    countAnswers() + " of " + attempt.questions.length + " answered";
  $("answer-progress").value = countAnswers();
  const status = $("save-state");
  const fixes = $("sync-actions");
  fixes.replaceChildren();
  status.classList.toggle("error", Boolean(draft && !saving));
  if (saving) {
    status.textContent = "Saving answer…";
    return;
  }
  if (!draft) {
    status.textContent = attempt.answers[attempt.questions[current].id]?.length
      ? "Answer saved."
      : "Choose an answer now or return to this question later.";
    return;
  }
  status.textContent = draft.message || "This answer has not been saved.";
  fixes.append(
    button(
      draft.phase === "conflict" ? "Save my choice" : "Retry save",
      "text-action",
      save,
    ),
    button("Use saved answer", "text-action", () => {
      draft = null;
      questionView(true);
    }),
  );
}
function equalChoices(a = [], b = []) {
  return a.length === b.length && a.every((choice) => b.includes(choice));
}
async function save() {
  if (saving || !draft || view !== "question") return;
  if (!timeLeft()) {
    expireView();
    return;
  }
  const pending = draft;
  const expectedReference = attempt.reference;
  const epoch = candidateEpoch;
  saving = true;
  refreshSave();
  try {
    const data = await api("answers", "PUT", {
      reference: expectedReference,
      questionId: pending.questionId,
      choices: pending.choices,
      revision: attempt.revision,
    });
    if (epoch !== candidateEpoch || view !== "question" || draft !== pending) return;
    receive(data, expectedReference);
    draft = null;
    if (attempt?.status !== "active") resume();
  } catch (error) {
    if (epoch !== candidateEpoch || view !== "question" || draft !== pending) return;
    if ([409, 403, 401, 410].includes(error.status)) {
      try {
        const data = await scopedSession(expectedReference, epoch);
        if (!data || epoch !== candidateEpoch || view !== "question" || draft !== pending) return;
        if (!attempt || attempt.status !== "active") {
          draft = null;
          resume();
          return;
        }
        if (
          equalChoices(attempt.answers[pending.questionId], pending.choices)
        ) {
          draft = null;
          return;
        }
        pending.phase = "conflict";
        pending.message =
          "The saved assessment changed. Save your choice again or use the saved answer.";
      } catch {
        if (epoch !== candidateEpoch) return;
        if ([401, 403, 409, 410].includes(error.status)) {
          clearCandidateState("This tab can no longer access that assessment. Open your personal invitation to continue.");
          return;
        }
        pending.message =
          "We could not check the saved answer. Reconnect and retry.";
      }
    } else
      pending.message =
        error.status === 0
          ? "Your choice is waiting to sync. Reconnect and retry before leaving this page."
          : error.message;
  } finally {
    saving = false;
    refreshSave();
  }
}
function review() {
  if (draft || saving) return;
  switchView("review");
  const frame = el("div", "work-frame");
  const card = el("section", "form-card");
  const heading = el("h2", "", "Review your answers");
  const total = attempt.questions.length;
  const complete = countAnswers() === total;
  card.append(
    el("p", "q-num", "Final review"),
    heading,
    el(
      "p",
      "body-copy",
      complete
        ? "All questions have a saved answer. Select a question to revisit it, or submit your assessment."
        : "Select an unanswered question to complete it. You can revisit any answer before submitting.",
    ),
  );
  const list = el("div", "review-list");
  for (const [index, question] of attempt.questions.entries()) {
    const answered = Boolean(attempt.answers[question.id]?.length);
    const item = button("", "review-item", () => {
      current = index;
      questionView(true);
    });
    item.setAttribute(
      "aria-label",
      "Question " + (index + 1) + ", " + (answered ? "answered" : "unanswered"),
    );
    item.append(
      el("span", "review-dot" + (answered ? " filled" : "")),
      el("span", "", "Question " + (index + 1)),
      el("small", "", answered ? "Answered" : "Unanswered"),
    );
    list.append(item);
  }
  const submit = button("Submit assessment", "button primary", confirmSubmit);
  submit.disabled = !complete;
  submit.id = "submit-paper";
  card.append(list, submit);
  frame.append(rail(), card);
  panel.append(frame);
  updateClock();
  if (view === "review") setFocus(heading);
}
function confirmSubmit() {
  const cancel = button("Keep reviewing", "button secondary", () =>
    dialog.close(),
  );
  const ok = button("Confirm submission", "button primary", () =>
    submit(cancel, ok),
  );
  dialogContent(
    "Submit your assessment?",
    [
      el(
        "p",
        "body-copy",
        "Your saved answers will be sent for review. You will see a confirmation and your assessment reference. Answers are final after submission.",
      ),
    ],
    [cancel, ok],
  );
}
async function submit(cancel, ok) {
  if (submitting || view !== "review") return;
  if (!timeLeft()) {
    expireView();
    return;
  }
  submitting = true;
  const expectedReference = attempt.reference;
  const epoch = candidateEpoch;
  cancel.disabled = true;
  ok.disabled = true;
  ok.textContent = "Submitting…";
  try {
    const data = await api("submit", "POST", {
      revision: attempt.revision,
      reference: expectedReference,
    });
    if (epoch !== candidateEpoch) return;
    receive(data, expectedReference);
    await rememberHistory();
    if (dialog.open) dialog.close();
    resume();
  } catch (error) {
    if (dialog.open) dialog.close();
    if (epoch !== candidateEpoch || view !== "review") return;
    try {
      const refreshed = await scopedSession(expectedReference, epoch);
      if (!refreshed || epoch !== candidateEpoch) return;
      if (!attempt || attempt.status !== "active") {
        resume();
        return;
      }
      review();
      showStatus(
        error.status === 0
          ? "Submission was not confirmed. Your saved answers are available. Submit again when connected."
          : "Your saved assessment was updated. Review your answers and submit again.",
      );
    } catch {
      if (epoch !== candidateEpoch) return;
      if ([401, 403, 409, 410].includes(error.status)) {
        clearCandidateState("This tab can no longer access that assessment. Open your personal invitation to continue.");
        return;
      }
      showStatus(
        "We could not confirm submission. Reconnect and check the assessment status.",
        checkSession,
      );
    }
  } finally {
    submitting = false;
    cancel.disabled = false;
    ok.disabled = false;
    ok.textContent = "Confirm submission";
    const link = $("review-nav");
    if (link && view === "review") link.disabled = false;
  }
}
async function checkSession() {
  const expectedReference = attempt?.reference || history.state?.reference;
  const epoch = candidateEpoch;
  if (!expectedReference) {
    clearCandidateState("Open your personal invitation to access an assessment.");
    return;
  }
  try {
    const restored = await scopedSession(expectedReference, epoch);
    if (!restored || epoch !== candidateEpoch) return;
    draft = null;
    resume();
  } catch (error) {
    if (epoch !== candidateEpoch) return;
    if ([401, 403, 409, 410].includes(error.status)) {
      clearCandidateState("This tab can no longer access that assessment. Open your personal invitation to continue.");
      return;
    }
    showStatus(error.message, checkSession);
  }
}
async function revalidateBoundTab() {
  if (!attempt?.reference) return updateClock();
  if (attempt.purgeAt && serverTime() >= attempt.purgeAt) return updateClock();
  const expectedReference = attempt.reference;
  const epoch = candidateEpoch;
  if (dialog.open) dialog.close();
  $("dialog-body").replaceChildren();
  switchView("refreshing");
  showStatus("Checking this assessment session…");
  try {
    const refreshed = await scopedSession(expectedReference, epoch);
    if (!refreshed || epoch !== candidateEpoch) return;
    resume();
  } catch (error) {
    if (epoch !== candidateEpoch) return;
    clearCandidateState(
      [401, 403, 409, 410].includes(error.status)
        ? "This tab can no longer access that assessment. Open your personal invitation to continue."
        : "This assessment could not be checked. Reopen your personal invitation when you are connected.",
      { broadcast: [401, 403, 409, 410].includes(error.status) },
    );
  }
}
async function expireView() {
  if (deadlineCheck) return;
  deadlineCheck = true;
  const expectedReference = attempt?.reference;
  const epoch = candidateEpoch;
  if (dialog.open) dialog.close();
  draft = null;
  switchView("deadline");
  const card = el("section", "content-card narrow");
  const heading = el("h1", "", "Checking your assessment");
  card.append(
    heading,
    el(
      "p",
      "body-copy",
      "The timer has ended. We are checking the status of your saved answers.",
    ),
  );
  panel.append(card);
  setFocus(heading);
  try {
    const restored = await scopedSession(expectedReference, epoch);
    if (!restored || epoch !== candidateEpoch) return;
    if (attempt.status === "active" && timeLeft() === 0) {
      showStatus(
        "The service is finalizing your attempt. Check its status again.",
        checkSession,
      );
    } else resume();
  } catch (error) {
    if (epoch !== candidateEpoch) return;
    if ([401, 403, 409, 410].includes(error.status)) {
      clearCandidateState("This tab can no longer access that assessment. Open your personal invitation to continue.");
      return;
    }
    showStatus(error.message, checkSession);
  } finally {
    deadlineCheck = false;
  }
}
function terminal() {
  if (dialog.open) dialog.close();
  switchView("terminal");
  const done = attempt.status === "submitted";
  const card = el("section", "content-card narrow");
  const mark = el("span", "receipt-mark", done ? "✓" : "◷");
  mark.setAttribute("aria-hidden", "true");
  const heading = el(
    "h1",
    "",
    done ? "Assessment submitted" : "Assessment time ended",
  );
  const details = definitionList([
    ["Assessment reference", attempt.reference],
    [
      "Receipt available until",
      attempt.purgeAt ? dateTime(attempt.purgeAt) : null,
    ],
    [
      "Saved answers",
      Number.isInteger(attempt.answered)
        ? attempt.answered + " of " + attempt.total
        : null,
    ],
    [
      done ? "Submitted" : "Deadline",
      done && attempt.submittedAt
        ? dateTime(attempt.submittedAt)
        : attempt.deadline
          ? dateTime(attempt.deadline)
          : null,
    ],
  ]);
  const referenceCell = details.querySelector("dd");
  if (referenceCell) referenceCell.classList.add("receipt-ref");
  card.append(
    mark,
    el("p", "eyebrow", done ? "Submission receipt" : "Assessment closed"),
    heading,
    el(
      "p",
      "body-copy",
      done
        ? "Your answers have been received. Keep your assessment reference if you contact your recruiter. The receipt is available for a limited time."
        : "The recruitment team can review the answers saved before the deadline. Contact your recruiter if you need support.",
    ),
    details,
  );
  panel.append(card);
  setFocus(heading);
}
async function bootstrap() {
  const version = ++bootstrapVersion;
  initializing = true;
  configFailed = false;
  bannerOnError = "";
  landing();
  try {
    if (explicitInvitation) {
      config = await api("config");
      if (version !== bootstrapVersion) return;
      if (!invite)
        throw new ApiError(
          "This invitation is incomplete. Open the original link from your recruiter.",
          403,
        );
      if (!config.enabled)
        throw new ApiError(
          "Recruitment invitations are currently unavailable. Contact your recruiter for help. You can explore the public sample.",
          403,
        );
      await prepareClaimKey();
      let inspected;
      try {
        inspected = await api("invitation", "POST", { invite });
      } catch (error) {
        if (error.status !== 403 || !claim || !claimVersion) throw error;
        // A start was expressly confirmed in this tab but its response may have been lost.
        inspected = await api("start", "POST", {
          invite,
          noticeVersion: claimVersion,
          claim,
          ...(claimIntegrityReview ? { integrityReview: true } : claimCopyShortcutReview ? { copyShortcutReview: true } : {}),
        });
        inspected.resume = true;
      }
      if (version !== bootstrapVersion) return;
      const invitedReference = /^[0-9a-f]{32}\.[a-f0-9]{64}$/.test(invite)
        ? invite.slice(0, 32)
        : "";
      if (!invitedReference ||
          (inspected.reference && inspected.reference !== invitedReference) ||
          (inspected.attempt && inspected.attempt.reference !== invitedReference))
        throw new ApiError("This invitation could not be matched to its assessment.", 403);
      if (inspected.anotherActiveSession) {
        throw new ApiError(
          "Open this invitation in a private browsing window or a separate browser profile.",
          409,
        );
      }
      if (inspected.resume) {
        if (!inspected.attempt || inspected.attempt.reference !== invitedReference)
          throw new ApiError(
            "Open your original invitation in a private browsing window.",
            403,
          );
        receive(inspected, invitedReference);
        clockBase = { server: inspected.serverNow ?? Date.now(), local: performance.now() };
        await rememberHistory();
        clearClaim();
        sessionChannel?.postMessage({ type: "invitation-changed", reference: invitedReference });
        invite = "";
        explicitInvitation = false;
      } else {
        invitation = inspected;
        clockBase = { server: inspected.serverNow ?? Date.now(), local: performance.now() };
      }
    } else {
      config = null;
      const scope = history.state;
      if (scope?.check && scope?.reference && scope.until > Date.now()) {
        const restored = await scopedSession(scope.reference);
        if (!restored) return;
        if ((await fingerprint(restored.attempt.reference)) === scope.check) {
          await rememberHistory();
          sessionChannel?.postMessage({ type: "invitation-changed", reference: scope.reference });
        } else {
          clearCandidateState("This tab can no longer access that assessment. Open your personal invitation to continue.");
        }
      } else if (scope?.check) history.replaceState(null, "", "");
    }
  } catch (error) {
    if (version !== bootstrapVersion) return;
    attempt = null;
    invitation = null;
    draft = null;
    clearClaim();
    history.replaceState(null, "", "");
    if (dialog.open) dialog.close();
    $("dialog-body").replaceChildren();
    configFailed = error.status === 0 || error.status >= 500;
    bannerOnError = error.message;
    if (explicitInvitation && error.status === 403 && config?.enabled) {
      bannerOnError =
        "This invitation could not be opened. Check the original link or use a private browsing window. Contact your recruiter if it still does not open.";
    }
  }
  initializing = false;
  if (attempt) resume();
  else if (view === "landing") landing();
}
$("open-privacy").addEventListener("click", () =>
  dialogContent("Privacy notice", privacyContent()),
);
$("open-support").addEventListener("click", () =>
  dialogContent("Access & support", [
    el(
      "p",
      "body-copy",
      invite || invitation || attempt
        ? "This personal link opens a recruitment assessment governed by the country privacy notice shown before start. The public practice privacy description does not apply here."
        : "Start practice assessment is open to everyone and needs no sign-in. Your answers stay in this tab until you submit; the service returns a private practice score without saving a practice record or sending it to recruiters.",
    ),
    el(
      "p",
      "body-copy",
      "A recruitment assessment is separate. Open the personal invitation supplied by your recruiter and read its country privacy notice. Use the same browser to resume a started assessment.",
    ),
    el(
      "p",
      "body-copy",
      "You can use a keyboard to choose answers and move between questions. If you need an adjustment or experience a technical problem, contact the recruiter who supplied your invitation.",
    ),
  ]),
);
function selectionIsInActiveQuestion(card) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
  const roots = [
    card.querySelector("#question-title"),
    card.querySelector(".table-scroll"),
    card.querySelector("#choices"),
  ].filter(Boolean);
  return [selection.anchorNode, selection.focusNode].every((node) =>
    node && roots.some((root) => root.contains(node)),
  );
}
function activeIntegrityQuestion() {
  return view === "question" && document.visibilityState === "visible" && !dialog.open &&
    attempt?.status === "active" && timeLeft() > 0 &&
    integrityMode(attempt.notice) !== "off" ? attempt.questions[current] : null;
}
function updateIntegrityLocalStatus() {
  const status = $("integrity-local-status");
  if (!status) return;
  const counts = Object.fromEntries([...integrityReported].map(([kind, ids]) => [kind, ids.size]));
  status.textContent = `In this tab, acknowledged observations: copy ${counts.copy}, context menu ${counts.contextMenu}, page hidden ${counts.pageHidden}. Categories can overlap. These counts may be incomplete and do not establish outside assistance.`;
}
function syncCopyShortcutListener() {
  const mode = integrityMode(attempt?.notice);
  const enabled = view === "question" && attempt?.status === "active" && mode !== "off";
  if (enabled && !copyShortcutListenerAttached) {
    document.addEventListener(mode === "legacy" ? "keydown" : "copy", mode === "legacy" ? reportCopyShortcut : reportNativeCopy);
    if (mode === "integrity") document.addEventListener("contextmenu", reportContextMenu);
    copyShortcutListenerAttached = true;
  } else if (!enabled && copyShortcutListenerAttached) {
    document.removeEventListener("keydown", reportCopyShortcut);
    document.removeEventListener("copy", reportNativeCopy);
    document.removeEventListener("contextmenu", reportContextMenu);
    copyShortcutListenerAttached = false;
  }
}
function reportNativeCopy(event) {
  if (!event.isTrusted || integrityMode(attempt?.notice) !== "integrity") return;
  const question = activeIntegrityQuestion();
  const card = $("active-question");
  if (question && card && selectionIsInActiveQuestion(card)) reportIntegrity("copy", question);
}
function eventInsideQuestion(event) {
  const card = $("active-question"), target = event.target;
  if (!card || !(target instanceof Node) || !card.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  if (!element || element.closest("dialog,[contenteditable=true],input,textarea,select,button")) return false;
  return Boolean(element.closest("#question-title,.table-scroll,#choices"));
}
function reportContextMenu(event) {
  if (!event.isTrusted || integrityMode(attempt?.notice) !== "integrity" || !eventInsideQuestion(event)) return;
  const question = activeIntegrityQuestion();
  if (question) reportIntegrity("contextMenu", question);
}
function reportIntegrity(kind, question, { keepalive = false } = {}) {
  const mode = integrityMode(attempt?.notice);
  if (mode !== "integrity" && !(mode === "legacy" && kind === "copy")) return;
  const reference = attempt.reference, epoch = candidateEpoch;
  const key = `${epoch}:${reference}:${kind}:${question.id}`;
  if (integrityReported.get(kind)?.has(question.id) || integrityPending.has(key)) return;
  if (mode === "legacy" && (copySignalReported.has(`${epoch}:${question.id}`) || copySignalPending.has(`${epoch}:${question.id}`))) return;
  integrityPending.add(key);
  if (mode === "legacy") copySignalPending.add(`${epoch}:${question.id}`);
  const payload = { reference, questionId: question.id, ...(mode === "integrity" ? { kind } : {}) };
  const request = keepalive
    ? fetch("/api/integrity", { method: "PUT", credentials: "same-origin", cache: "no-store", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Assessment-Reference": reference }, body: JSON.stringify(payload) })
        .then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(); return data; })
    : api("integrity", "PUT", payload, reference);
  void request.then(data => {
      if (epoch !== candidateEpoch || attempt?.reference !== reference || data?.recorded !== true) return;
      integrityReported.get(kind)?.add(question.id);
      if (mode === "legacy") copySignalReported.add(`${epoch}:${question.id}`);
      updateIntegrityLocalStatus();
    }).catch(() => {}).finally(() => { integrityPending.delete(key); copySignalPending.delete(`${epoch}:${question.id}`); });
}
function reportCopyShortcut(event) {
  if (!event.isTrusted || event.repeat || event.isComposing || view !== "question" ||
      document.visibilityState !== "visible" || dialog.open || timeLeft() <= 0 ||
      attempt?.status !== "active" || attempt.notice?.copyShortcutReview !== true) return;
  if (event.altKey || event.shiftKey || event.ctrlKey === event.metaKey ||
      !(event.ctrlKey || event.metaKey)) return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable ||
      target.matches("textarea, select, input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit])"))) return;
  if (typeof event.key !== "string" || event.key.toLowerCase() !== "c") return;
  const question = attempt.questions[current];
  const card = $("active-question");
  if (!question || !card || !selectionIsInActiveQuestion(card)) return;
  reportIntegrity("copy", question);
}
let observedVisible = document.visibilityState === "visible";
document.addEventListener("visibilitychange", (event) => {
  if (!event.isTrusted) return;
  if (document.visibilityState === "visible") { observedVisible = true; return; }
  if (document.visibilityState !== "hidden" || !observedVisible) return;
  observedVisible = false;
  if (integrityMode(attempt?.notice) !== "integrity" || dialog.open) return;
  const question = view === "question" && attempt?.status === "active" && timeLeft() > 0 ? attempt.questions[current] : null;
  if (question) reportIntegrity("pageHidden", question, { keepalive: true });
});
dialog.addEventListener("cancel", (event) => {
  if (submitting) event.preventDefault();
});
window.addEventListener("online", () => {
  if (attempt) revalidateBoundTab();
  else if (view === "deadline") checkSession();
});
window.addEventListener("beforeunload", (event) => {
  if (
    !window.assessmentChangingInvitation &&
    (draft || saving || submitting || startPending)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) revalidateBoundTab();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted || attempt) revalidateBoundTab();
  else updateClock();
});
window.addEventListener("focus", revalidateBoundTab);
sessionChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "invitation-changed" || !attempt) return;
  if (event.data.reference === attempt.reference) return;
  clearCandidateState(
    "This browser is now connected to a different invitation. Open your personal link to continue.",
  );
});
setInterval(updateClock, 1000);
bootstrap().catch(() => {
  initializing = false;
  configFailed = true;
  bannerOnError =
    "The assessment could not be loaded. Reconnect and try again.";
  landing();
});
