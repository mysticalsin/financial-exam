import { makePaper, grade, reviewPaper } from "./bank.js";
import { authorizeReviewer, reviewerConfigured } from "./access.js";
import { handlePractice } from "./practice.js";

const MINUTE = 60000;
const HARD_LIFETIME = 60 * MINUTE;
const POST_ATTEMPT_WINDOW = 30 * MINUTE;
const COOKIE = "__Host-assessment";
const TOKEN = /^([0-9a-f]{32})\.([0-9a-f]{64})$/;
const CLAIM = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CLIENT_OBSERVATIONS = ["copy", "contextMenu", "pageHidden"];
const OBSERVATIONS = [...CLIENT_OBSERVATIONS, "rejectedAnswer"];
const MAX_OBSERVED_QUESTIONS = 15;
const MAX_BODY = 2048;
const encoder = new TextEncoder();
const requiredNotice = [
  "controller", "contact", "basis", "recipients", "transfers", "rights",
  "purpose", "supervisoryAuthority", "version",
];

const responseHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": [
    "default-src 'none'", "script-src 'self'", "style-src 'self'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), clipboard-read=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function demand(condition, status, message) {
  if (!condition) throw new RequestError(status, message);
}

function json(payload, status = 200, headers) {
  return Response.json(payload, { status, headers: { ...responseHeaders, ...headers } });
}

function failure(error) {
  return error instanceof RequestError
    ? json({ error: error.message }, error.status)
    : json({ error: "The service is temporarily unavailable. Please try again." }, 503);
}

function bounded(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function decoded(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function profiles(env) {
  const values = env.NOTICE_PROFILES === undefined
    ? { [env.PRIVACY_COUNTRY ?? ""]: decoded(env.PRIVACY_NOTICE) }
    : decoded(env.NOTICE_PROFILES);
  const approved = {};
  for (const [country, value] of Object.entries(values ?? {})) {
    if (!/^[A-Z]{2}$/.test(country) || !value || value.retentionMinutes !== 30) continue;
    if (requiredNotice.some(k => typeof value[k] !== "string" || !value[k].trim())) continue;
    const notice = Object.fromEntries(requiredNotice.map(k => [k, value[k].trim()]));
    approved[country] = { ...notice, retentionMinutes: 30 };
    if (value.integrityReview === true) approved[country].integrityReview = true;
    else if (value.copyShortcutReview === true) approved[country].copyShortcutReview = true;
  }
  return approved;
}

function config(env) {
  const approved = profiles(env);
  const countries = Object.keys(approved).sort();
  const durationMinutes = Number(env.DURATION_MINUTES ?? 15);
  const inviteTtlMinutes = Number(env.INVITE_TTL_MINUTES ?? 30);
  const enabled = env.LIVE_ENABLED === "true" && countries.length > 0 &&
    reviewerConfigured(env) &&
    !!env.RATE_LIMITER && !!env.ATTEMPTS && !!env.RECORDS &&
    bounded(durationMinutes, 5, 55) && bounded(inviteTtlMinutes, 1, 30);
  return { enabled, durationMinutes, inviteTtlMinutes, countries,
    notice: countries.length === 1 ? approved[countries[0]] : null };
}

function requireLive(settings) {
  demand(settings.enabled, 503, "Scored assessments are currently closed.");
}

function hex(bytes) {
  return Array.from(bytes, v => v.toString(16).padStart(2, "0")).join("");
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

// Compare fixed-length SHA-256 hex digests; the loop never exits on a matching prefix.
function equalDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== 64 || right.length !== 64) return false;
  let changed = 0;
  for (let i = 0; i < 64; i++) changed |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return changed === 0;
}

function requestCookie(request) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(COOKIE + "=")) return TOKEN.exec(value.slice(COOKIE.length + 1));
  }
  return null;
}

function cookieHeader(value, until) {
  const seconds = Math.max(0, Math.floor((until - Date.now()) / 1000));
  return COOKIE + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + seconds;
}

function browserWrite(request, url) {
  demand(request.headers.get("Origin") === url.origin, 403, "Please use the assessment page to make this change.");
}

async function body(request, fields) {
  demand(request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json",
    415, "A JSON request is required.");
  demand(Number(request.headers.get("Content-Length")) <= MAX_BODY, 413, "Request is too large.");
  const reader = request.body?.getReader();
  demand(reader, 400, "Please check the request.");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new RequestError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  let data;
  try { data = JSON.parse(await new Blob(chunks).text()); } catch { /* rejected below */ }
  demand(data && typeof data === "object" && !Array.isArray(data) &&
    Object.keys(data).every(k => fields.includes(k)), 400, "Please check the request.");
  return data;
}

let anonymousSalt;
async function throttle(request, env, operation, ref) {
  demand(env.RATE_LIMITER, 503, "The service is temporarily unavailable.");
  // Identity for a single minute only. Neither application logs nor the assessment store receive IP addresses.
  const minute = Math.floor(Date.now() / 60000);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  anonymousSalt ??= randomHex(32);
  const salt = env.RATE_KEY || env.OPS_TOKEN || anonymousSalt;
  const networkKey = await digest(JSON.stringify([salt, minute, ip, operation]));
  const network = await env.RATE_LIMITER.limit({ key: networkKey });
  demand(network.success, 429, "Too many requests. Please try again in a minute.");
  if (ref) {
    const attemptKey = await digest(JSON.stringify([minute, operation, ref]));
    const attempt = await env.RATE_LIMITER.limit({ key: attemptKey });
    demand(attempt.success, 429, "Too many requests. Please try again in a minute.");
  }
}

function callAttempt(env, ref, action, data = {}) {
  const namespace = env.ATTEMPTS.jurisdiction("eu");
  const stub = namespace.get(namespace.idFromName(ref));
  return stub.fetch(new Request("https://assessment.internal/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }));
}

async function adminRoute(request, env, url, settings) {
  await throttle(request, env, "operator");
  const fromBrowser = ["Origin", "Sec-Fetch-Site", "Cf-Access-Jwt-Assertion"].some(h => request.headers.has(h));
  if (fromBrowser) {
    demand(await authorizeReviewer(request, env), 403, "Reviewer sign-in required.");
    if (request.method !== "GET") {
      browserWrite(request, url);
      if (request.method === "DELETE") await body(request, []);
    }
  } else {
    demand(typeof env.OPS_TOKEN === "string" && env.OPS_TOKEN.length >= 32, 403, "Operator access required.");
    const expected = await digest("Bearer " + env.OPS_TOKEN);
    demand(equalDigest(await digest(request.headers.get("Authorization") ?? ""), expected), 403, "Operator access required.");
  }
  if (url.pathname === "/api/ops/whoami" && request.method === "GET") return json({ authorized: true });
  if (url.pathname === "/api/ops/invites" && request.method === "POST") {
    requireLive(settings);
    const data = await body(request, ["durationMinutes", "country"]);
    const durationMinutes = data.durationMinutes === undefined ? settings.durationMinutes : data.durationMinutes;
    demand(bounded(durationMinutes, 5, 55), 422, "Choose a duration from 5 to 55 minutes.");
    const country = data.country ?? (settings.countries.length === 1 ? settings.countries[0] : null);
    demand(settings.countries.includes(country), 422, "Choose a country with an approved privacy notice.");
    const reference = randomHex(16);
    const secret = randomHex(32);
    const inviteTtlMinutes = settings.inviteTtlMinutes;
    const issued = await callAttempt(env, reference, "issue", {
      reference, inviteHash: await digest(secret), country, inviteTtlMinutes, durationMinutes,
    });
    if (!issued.ok) return issued;
    return json({ ...(await issued.json()), invite: reference + "." + secret }, 201);
  }
  const match = /^\/api\/ops\/attempts\/([0-9a-f]{32})$/.exec(url.pathname);
  if (match && (request.method === "GET" || request.method === "DELETE")) {
    return callAttempt(env, match[1], request.method === "GET" ? "export" : "erase");
  }
  throw new RequestError(404, "Route not found.");
}

async function candidateRoute(request, env, url, settings) {
  const session = requestCookie(request);
  const path = url.pathname;
  if (path === "/api/config" && request.method === "GET") return json(settings);
  if (path === "/api/session" && request.method === "GET") {
    const expected = request.headers.get("X-Assessment-Reference");
    if (!settings.enabled || !session) return json({ attempt: null, serverNow: Date.now() });
    demand(typeof expected === "string" && /^[0-9a-f]{32}$/.test(expected), 400,
      "Reopen your personal invitation to access this assessment.");
    demand(expected === session[1], 409,
      "The active invitation changed. Reopen your personal invitation to continue.");
  }
  requireLive(settings);
  if (request.method !== "GET") browserWrite(request, url);
  if ((path === "/api/start" || path === "/api/invitation") && request.method === "POST") {
    await throttle(request, env, "invitation");
    const start = path === "/api/start";
    const data = await body(request, start ? ["invite", "claim", "noticeVersion", "copyShortcutReview", "integrityReview"] : ["invite"]);
    const match = typeof data.invite === "string" && TOKEN.exec(data.invite);
    demand(match, 403, "This invitation is unavailable. Please contact your recruiter.");
    const [, reference, secret] = match;
    const inviteHash = await digest(secret);
    const browserHash = session ? await digest(session[2]) : null;
    let anotherActiveSession = false;
    if (session && session[1] !== reference) {
      const probe = await callAttempt(env, session[1], "active", { sessionHash: browserHash });
      if (!probe.ok) return probe;
      anotherActiveSession = (await probe.json()).active;
    }
    if (!start) return callAttempt(env, reference, "inspect", {
      inviteHash, sessionHash: session?.[1] === reference ? browserHash : null, anotherActiveSession,
    });
    demand(!anotherActiveSession, 409, "Another assessment is active in this browser. Open this invitation in a separate browser.");
    demand(typeof data.claim === "string" && CLAIM.test(data.claim), 400, "Please restart from your invitation.");
    // Derivation makes a lost start response recoverable on the same browser without persisting a reusable credential.
    const sessionSecret = await digest("assessment-session-v1/" + secret + "/" + data.claim);
    const response = await callAttempt(env, reference, "start", {
      inviteHash, sessionHash: await digest(sessionSecret), noticeVersion: data.noticeVersion,
      copyShortcutReview: data.copyShortcutReview, integrityReview: data.integrityReview,
    });
    if (!response.ok) return response;
    const result = await response.json();
    return json(result, 200, { "Set-Cookie": cookieHeader(reference + "." + sessionSecret, result.attempt.purgeAt) });
  }
  const actions = {
    "GET /api/session": ["view", []],
    "PUT /api/answers": ["answer", ["questionId", "choices", "revision", "reference"]],
    "PUT /api/integrity": ["integrity", ["questionId", "reference", "kind"]],
    "POST /api/submit": ["submit", ["revision", "reference"]],
  };
  const action = actions[request.method + " " + path];
  demand(action, 404, "Route not found.");
  demand(session, 401, "Your session is unavailable. Please reopen your invitation.");
  const [name, fields] = action;
  await throttle(request, env, name === "integrity" ? "copy-shortcut" : "session", session[1]);
  const data = fields.length ? await body(request, fields) : {};
  if (name !== "view")
    demand(data.reference === session[1], 409, "The active invitation changed. Reopen your invitation to continue.");
  const response = await callAttempt(env, session[1], name, { ...data, sessionHash: await digest(session[2]) });
  if (!response.ok || name !== "submit") return response;
  const result = await response.json();
  return json(result, 200, { "Set-Cookie": cookieHeader(session[0], result.attempt.purgeAt) });
}

export default {
  async scheduled(_event, env) {
    // Primary cleanup is each invitation's alarm. The sweep recovers missed alarms.
    const namespace = env.ATTEMPTS.jurisdiction("eu");
    let cursor;
    let failed = false;
    do {
      const page = await env.RECORDS.list({ cursor, limit: 200, include: ["customMetadata"] });
      for (const entry of page.objects) {
        if (Number(entry.customMetadata?.compactAt ?? entry.customMetadata?.purgeAt) > Date.now()) continue;
        try {
          const id = namespace.idFromString(entry.key);
          const result = await namespace.get(id).fetch(new Request("https://assessment.internal/reconcile", {
            method: "POST", body: "{}",
          }));
          if (!result.ok) failed = true;
        } catch { failed = true; }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (failed) throw new Error("Scheduled cleanup requires a retry.");
  },
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      demand(url.protocol === "https:" || loopback, 400, "An HTTPS connection is required.");
      if (url.pathname.startsWith("/api/")) {
        demand(!url.search, 400, "Use the assessment page to make this request.");
        if (url.pathname === "/api/practice/start" || url.pathname === "/api/practice/submit")
          return await handlePractice(request, env, throttle);
        const settings = config(env);
        return url.pathname.startsWith("/api/ops/")
          ? await adminRoute(request, env, url, settings)
          : await candidateRoute(request, env, url, settings);
      }
      demand(request.method === "GET" || request.method === "HEAD", 405, "Method not allowed.");
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [header, value] of Object.entries(responseHeaders)) response.headers.set(header, value);
      return response;
    } catch (error) { return failure(error); }
  },
};

function candidateState(record) {
  const active = record.status === "active";
  const submitted = record.status === "submitted";
  return {
    reference: record.reference, revision: record.revision, status: record.status,
    country: record.country, notice: record.notice,
    deadline: record.deadline, purgeAt: record.purgeAt, startedAt: record.startedAt, submittedAt: record.submittedAt ?? null,
    questions: active ? record.paper.questions : [], answers: active ? record.answers : {},
    total: record.paper.questions.length, answered: Object.keys(record.answers).length,
    ...(submitted ? { score: record.score, review: reviewPaper(record.paper, record.answers) } : {}),
  };
}

function view(record, now) {
  return { attempt: candidateState(record), serverNow: now };
}

function requireAcknowledgment(notice, data) {
  demand(data.integrityReview === notice.integrityReview && data.copyShortcutReview === notice.copyShortcutReview,
    409, "Review the integrity notice before continuing.");
}

function compactIntegrity(record) {
  if (record.notice?.integrityReview === true) {
    const counts = {};
    for (const kind of OBSERVATIONS) {
      const mask = record.integrityMasks?.[kind] ?? 0;
      let count = 0;
      for (let i = 0; i < MAX_OBSERVED_QUESTIONS; i++) count += (mask >>> i) & 1;
      counts[kind] = count;
    }
    record.integritySummary = counts;
    delete record.integrityMasks;
    return;
  }
  if (record.notice?.copyShortcutReview !== true) return;
  record.copiedQuestionCount = record.copiedQuestionIds?.length ?? 0;
  delete record.copiedQuestionIds;
}

function compactAt(record) {
  return record.status === "active" && (record.notice?.integrityReview === true || record.notice?.copyShortcutReview === true)
    ? record.deadline : undefined;
}

function operatorRecord(record) {
  const { reference, country, status, issuedAt, expiresAt, durationMinutes, purgeAt } = record;
  const result = {
    reference, country, status, issuedAt, inviteExpiresAt: expiresAt, durationMinutes, purgeAt,
    timeUnit: "Unix milliseconds (UTC)", score: null,
  };
  if (!record.paper) return result;
  const details = {
    ...result, startedAt: record.startedAt, deadline: record.deadline, submittedAt: record.submittedAt ?? null,
    notice: record.notice, score: record.score ?? null, total: record.paper.questions.length,
    answered: Object.keys(record.answers).length,
  };
  if (record.status === "active") return details;
  return {
    ...details,
    ...(record.notice.integrityReview === true ? { integritySummary: record.integritySummary } : {}),
    ...(record.notice.copyShortcutReview === true ? { copiedQuestionCount: record.copiedQuestionCount } : {}),
    scoringRule: "One point for each exact answer. A recruiter reviews the result. The app makes no hiring decision.",
    responses: record.paper.questions.map(q => ({
      question: q.prompt, section: q.section, table: q.table ?? null,
      selected: q.options.filter(o => record.answers[q.id]?.includes(o.id)).map(o => o.text),
      expected: q.options.filter(o => record.paper.key[q.id].includes(o.id)).map(o => o.text),
      explanation: record.paper.notes?.[q.id] ?? null,
    })),
  };
}

export class Assessment {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.key = ctx.id.toString();
  }

  async read() {
    const entry = await this.env.RECORDS.get(this.key);
    return entry ? { record: await entry.json(), etag: entry.etag } : null;
  }

  async erase() {
    // R2 delete is strongly consistent. Keep the alarm until the primary data is gone.
    await this.env.RECORDS.delete(this.key);
    await this.ctx.storage.deleteAll();
  }

  // Serialize claim, save, submit, and erase across all requests for this one invitation.
  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    const data = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      try { return await this.handle(action, data); }
      catch (error) { return failure(error); }
    });
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(() => this.handle("alarm", {}));
  }

  async persist(record, etag, reschedule = false) {
    // Schedule first so a crash on first write cannot strand a record without a cleanup timer.
    // A prematurely firing alarm re-reads R2 to get the committed expiry.
    const deadline = compactAt(record);
    if (reschedule) await this.ctx.storage.setAlarm(deadline ?? record.purgeAt);
    // A timed-out storage request can still commit. A late update must never
    // overwrite a newer revision or recreate an object after an erasure.
    const written = await this.env.RECORDS.put(this.key, JSON.stringify(record), {
      customMetadata: { purgeAt: String(record.purgeAt), ...(deadline ? { compactAt: String(deadline) } : {}) },
      onlyIf: etag ? { etagMatches: etag } : new Headers({ "If-None-Match": "*" }),
    });
    demand(written, 409, "The record changed. Please reload before trying again.");
    return written.etag;
  }

  async recordObservation(record, etag, questionIndex, kind) {
    demand(questionIndex >= 0 && questionIndex < MAX_OBSERVED_QUESTIONS, 422, "Choose a question from this assessment.");
    // Fixed-size masks carry membership only. Their bits refer to the issued order.
    const bit = 1 << questionIndex;
    const previous = record.integrityMasks?.[kind] ?? 0;
    if (previous & bit) return;
    record.integrityMasks ??= {};
    record.integrityMasks[kind] = previous | bit;
    await this.persist(record, etag);
  }

  async handle(action, data) {
    const entry = await this.read();
    let record = entry?.record;
    let etag = entry?.etag;
    const now = Date.now();
    if (record && record.purgeAt <= now) {
      await this.erase();
      record = undefined;
      etag = undefined;
    }
    if (action === "issue") {
      demand(!record, 409, "Invitation could not be created. Try again.");
      const { reference, inviteHash, country, durationMinutes, inviteTtlMinutes } = data;
      const hardEnd = now + HARD_LIFETIME;
      const expiresAt = Math.min(now + inviteTtlMinutes * MINUTE, hardEnd - durationMinutes * MINUTE);
      record = { reference, inviteHash, country, expiresAt, hardEnd, durationMinutes, issuedAt: now,
        status: "invited", revision: 0, purgeAt: expiresAt };
      await this.persist(record, etag, true);
      return json({ reference, expiresAt, hardEnd, country, durationMinutes });
    }
    if (action === "erase") {
      await this.erase();
      return json({ erased: true });
    }
    if (!record && action === "active") return json({ active: false });
    if (!record && action === "view") return json({ attempt: null, serverNow: now });
    if (!record && (action === "reconcile" || action === "alarm")) {
      if (action === "alarm") await this.ctx.storage.deleteAll();
      return json({ checked: true });
    }
    demand(record, action === "export" ? 404 : 403,
      action === "export" ? "No retained record found." : "This invitation is unavailable. Please contact your recruiter.");
    if (record.status === "active" && record.deadline <= now) {
      const hadCompactionAlarm = compactAt(record) !== undefined;
      record.status = "expired";
      compactIntegrity(record);
      record.revision++;
      etag = await this.persist(record, etag, hadCompactionAlarm && action !== "alarm");
    }
    if (action === "alarm") {
      await this.ctx.storage.setAlarm(compactAt(record) ?? record.purgeAt);
      return json({ checked: true });
    }
    if (action === "reconcile") return json({ checked: true });
    if (action === "export") return json(operatorRecord(record));
    if (action === "active") return json({ active: record.status === "active" && equalDigest(record.sessionHash, data.sessionHash) });
    if (action === "start" || action === "inspect") {
      demand(equalDigest(record.inviteHash, data.inviteHash), 403, "This invitation is unavailable. Please contact your recruiter.");
      const notice = profiles(this.env)[record.country];
      demand(notice, 403, "This country is currently closed for scored assessments.");
      if (action === "inspect") {
        const details = { reference: record.reference, country: record.country, notice: record.notice ?? notice,
          durationMinutes: record.durationMinutes, expiresAt: record.expiresAt, hardEnd: record.hardEnd, serverNow: now };
        if (record.status === "invited") return json({ ...details, resume: false, anotherActiveSession: data.anotherActiveSession });
        demand(equalDigest(record.sessionHash, data.sessionHash), 403, "This invitation has already been used.");
        return json({ ...details, resume: true, ...view(record, now) });
      }
      if (record.status === "invited") {
        demand(data.noticeVersion === notice.version, 409, "The privacy notice changed. Reload your invitation before starting.");
        requireAcknowledgment(notice, data);
        const deadline = now + record.durationMinutes * MINUTE;
        demand(deadline <= record.hardEnd, 403, "The full time allowance is no longer available. Request a fresh invitation.");
        Object.assign(record, { startedAt: now, deadline, purgeAt: Math.min(deadline + POST_ATTEMPT_WINDOW, record.hardEnd),
          sessionHash: data.sessionHash, notice, paper: makePaper(), answers: {}, status: "active", revision: 1 });
        await this.persist(record, etag, true);
      } else {
        demand(equalDigest(record.sessionHash, data.sessionHash), 403,
          "This invitation has already been used. Continue in the browser where you started.");
        requireAcknowledgment(record.notice, data);
      }
      return json(view(record, now));
    }
    const hasSession = equalDigest(record.sessionHash, data.sessionHash);
    if (!hasSession && action === "view") return json({ attempt: null, serverNow: now });
    demand(hasSession, 401, "Your session is unavailable. Please contact your recruiter.");
    if (action === "view") return json(view(record, now));
    if (action === "submit" && record.status === "submitted") return json(view(record, now));
    demand(record.status === "active", 409, "This assessment has closed.");
    if (action === "integrity") {
      if (record.notice.integrityReview === true) {
        demand(CLIENT_OBSERVATIONS.includes(data.kind), 422, "Choose an available observation category.");
        const index = record.paper.questions.findIndex(q => q.id === data.questionId);
        await this.recordObservation(record, etag, index, data.kind);
        return json({ recorded: true });
      }
      demand(record.notice.copyShortcutReview === true, 403, "Shortcut reporting is disabled for this assessment.");
      demand(!Object.hasOwn(data, "kind"), 400, "This assessment uses shortcut-only reporting.");
      demand(record.paper.questions.some(q => q.id === data.questionId), 422, "Choose a question from this assessment.");
      record.copiedQuestionIds ??= [];
      if (!record.copiedQuestionIds.includes(data.questionId)) {
        record.copiedQuestionIds.push(data.questionId);
        await this.persist(record, etag);
      }
      return json({ recorded: true });
    }
    demand(Number.isSafeInteger(data.revision) && data.revision >= 1, 422, "A valid revision is required.");
    if (action === "answer") {
      const index = record.paper.questions.findIndex(q => q.id === data.questionId);
      const question = record.paper.questions[index];
      demand(question, 422, "Choose a question from this assessment.");
      const choices = data.choices;
      if (record.notice.integrityReview === true && data.revision === record.revision && Array.isArray(choices) &&
          choices.length === 1 && typeof choices[0] === "string" && UUID.test(choices[0]) &&
          !question.options.some(o => o.id.toLowerCase() === choices[0].toLowerCase())) {
        await this.recordObservation(record, etag, index, "rejectedAnswer");
        throw new RequestError(422, "Choose an available answer.");
      }
      demand(Array.isArray(choices) && choices.length <= (question.multiple ? question.options.length : 1) &&
        new Set(choices).size === choices.length && choices.every(id => question.options.some(o => o.id === id)),
      422, "Choose an available answer.");
      const existing = record.answers[question.id] ?? [];
      const unchanged = existing.length === choices.length && choices.every(id => existing.includes(id));
      if (unchanged && data.revision <= record.revision) return json(view(record, now));
      demand(data.revision === record.revision, 409, "Your answers changed in another tab. Reload and try again.");
      if (choices.length) record.answers[question.id] = choices;
      else delete record.answers[question.id];
    } else if (action === "submit") {
      demand(data.revision === record.revision, 409, "Your answers changed in another tab. Reload and review before submitting.");
      demand(Object.keys(record.answers).length === record.paper.questions.length, 409, "Answer every question before submitting.");
      record.status = "submitted";
      compactIntegrity(record);
      record.submittedAt = now;
      record.purgeAt = Math.min(now + POST_ATTEMPT_WINDOW, record.hardEnd);
      record.score = grade(record.paper, record.answers);
    } else {
      throw new RequestError(404, "Route not found.");
    }
    record.revision++;
    await this.persist(record, etag, action === "submit");
    return json(view(record, now));
  }
}
