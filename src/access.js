import { createRemoteJWKSet, jwtVerify } from 'jose';

let cachedIssuer;
let cachedKeys;

export function reviewerConfigured(env) {
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER || '')
    && /^[a-f0-9]{64}$/i.test(env.ACCESS_AUD || '');
}

export async function authorizeReviewer(request, env) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !reviewerConfigured(env)) return false;
  const issuer = env.ACCESS_ISSUER;
  if (cachedIssuer !== issuer) {
    cachedKeys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer));
    cachedIssuer = issuer;
  }
  try {
    const {payload} = await jwtVerify(token, cachedKeys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp','iat','sub','email']
    });
    return payload.type === 'app' && typeof payload.email === 'string' && payload.email.length > 0;
  } catch {
    return false;
  }
}
