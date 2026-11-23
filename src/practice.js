import { clientQuestion, drawPracticePaper } from './bank.js';

const TOKEN_VERSION = 'p1';
const TICKET_LIFETIME = 30 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ticketContext = encoder.encode('mantu-financial-assessment-practice-v1');

const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

class PracticeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const fail = (status, message) => { throw new PracticeError(status, message); };
const json = (value, status = 200) => Response.json(value, { status, headers });
export function makePracticePaper() {
  const paper = drawPracticePaper();
  return { ...paper, questions: paper.questions.map(clientQuestion) };
}

function keyBytes(secret) {
  if (typeof secret !== 'string' || !/^[a-f\d]{64}$/i.test(secret)) fail(503, 'The practice service is not configured.');
  const raw = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.parseInt(secret.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  if (!/^[A-Za-z\d_-]+$/.test(value)) fail(400, 'This practice session is invalid. Start a new practice paper.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary;
  try { binary = atob(padded); } catch { fail(400, 'This practice session is invalid. Start a new practice paper.'); }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function encryptTicket(payload, secret) {
  const key = await crypto.subtle.importKey('raw', keyBytes(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ticketContext }, key,
    encoder.encode(JSON.stringify(payload)));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return TOKEN_VERSION + '.' + base64url(combined);
}

async function decryptTicket(token, secret) {
  if (typeof token !== 'string' || token.length > 16384) fail(400, 'This practice session is invalid. Start a new practice paper.');
  const [version, encoded, extra] = token.split('.');
  if (version !== TOKEN_VERSION || !encoded || extra !== undefined) fail(400, 'This practice session is invalid. Start a new practice paper.');
  const bytes = fromBase64url(encoded);
  if (bytes.length < 29) fail(400, 'This practice session is invalid. Start a new practice paper.');
  const key = await crypto.subtle.importKey('raw', keyBytes(secret), 'AES-GCM', false, ['decrypt']);
  try {
    const payload = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: ticketContext }, key, bytes.slice(12));
    return JSON.parse(decoder.decode(payload));
  } catch {
    fail(400, 'This practice session is invalid. Start a new practice paper.');
  }
}

async function readBody(request, fields) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'A JSON request is required.');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) fail(413, 'Request is too large.');
  if (!request.body) fail(400, 'Please check the request.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      fail(413, 'Request is too large.');
    }
    chunks.push(value);
  }
  let data;
  try { data = JSON.parse(await new Blob(chunks).text()); } catch { /* handled below */ }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !fields.includes(key)))
    fail(400, 'Please check the request.');
  return data;
}

function validateTicket(ticket, now) {
  if (!ticket || ticket.v !== 1 || !Number.isSafeInteger(ticket.issuedAt) || !Number.isSafeInteger(ticket.deadline) ||
      ticket.deadline !== ticket.issuedAt + TICKET_LIFETIME || !ticket.key || !ticket.choiceIds ||
      Object.keys(ticket.key).length !== 15 || Object.keys(ticket.choiceIds).length !== 15 ||
      Object.keys(ticket.key).some(id => !Object.hasOwn(ticket.choiceIds, id)))
    fail(400, 'This practice session is invalid. Start a new practice paper.');
  if (now >= ticket.deadline) fail(410, 'This practice paper has expired. Start a new one to continue.');
}

export function scorePractice(ticket, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length > 15)
    fail(400, 'Please check your selected answers.');
  let score = 0;
  for (const [questionId, optionId] of Object.entries(answers)) {
    if (!Object.hasOwn(ticket.choiceIds, questionId) || typeof optionId !== 'string' ||
        !ticket.choiceIds[questionId].includes(optionId)) fail(422, 'One or more selected answers do not belong to this practice paper.');
    if (ticket.key[questionId] === optionId) score++;
  }
  return { score, total: 15, answered: Object.keys(answers).length };
}

export async function handlePractice(request, env, throttle) {
  try {
    const url = new URL(request.url);
    if (request.headers.get('Origin') !== url.origin) fail(403, 'Please use the practice page to make this request.');
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const start = url.pathname === '/api/practice/start';
    const submit = url.pathname === '/api/practice/submit';
    if (!start && !submit) return json({ error: 'Route not found.' }, 404);
    await throttle(request, env, 'practice');
    const data = await readBody(request, start ? [] : ['challenge', 'answers']);
    const now = Date.now();
    if (start) {
      const paper = makePracticePaper();
      const payload = { v: 1, issuedAt: now, deadline: now + TICKET_LIFETIME, key: paper.key, choiceIds: paper.choiceIds };
      const challenge = await encryptTicket(payload, env.PRACTICE_KEY);
      return json({
        questions: paper.questions.map(clientQuestion),
        referenceTable: paper.referenceTable,
        challenge, serverNow: now, deadline: payload.deadline,
      });
    }
    if (typeof data.challenge !== 'string' || !data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers))
      fail(400, 'Please check your selected answers.');
    const ticket = await decryptTicket(data.challenge, env.PRACTICE_KEY);
    validateTicket(ticket, now);
    return json({ ...scorePractice(ticket, data.answers), submittedAt: now });
  } catch (error) {
    if (error instanceof PracticeError || (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599))
      return json({ error: error.message || 'The request could not be completed.' }, error.status);
    return json({ error: 'The practice service is temporarily unavailable. Please try again.' }, 503);
  }
}
