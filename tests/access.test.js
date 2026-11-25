import assert from 'node:assert/strict';
import test from 'node:test';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import {authorizeReviewer,reviewerConfigured} from '../src/access.js';

test('reviewer access requires a verified, unexpired application token for a named reviewer and intended audience',async t=>{
  const env={ACCESS_ISSUER:'https://test-team.cloudflareaccess.com',ACCESS_AUD:'c'.repeat(64)};
  const fixture=await generateKeyPair('RS256');
  const jwk={...await exportJWK(fixture.publicKey), kid:'synthetic', alg:'RS256'};
  const remote=t.mock.method(globalThis,'fetch',async url=>{
    assert.equal(String(url),env.ACCESS_ISSUER+'/cdn-cgi/access/certs');
    return Response.json({keys:[jwk]});
  });
  const now=Math.floor(Date.now()/1000);
  const claims={type:'app',email:'reviewer@example.invalid',sub:'synthetic-reviewer',exp:now+300,iat:now,iss:env.ACCESS_ISSUER,aud:env.ACCESS_AUD};
  const request=async (alter={}, key=fixture.privateKey)=>{
    const signed=await new SignJWT({...claims,...alter}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).sign(key);
    return new Request('https://assessment.example.invalid/api/ops/whoami',{headers:{'cf-access-jwt-assertion':signed}});
  };
  assert.equal(await authorizeReviewer(await request(),env),true);
  assert.equal(await authorizeReviewer(await request({aud:'other-app'}),env),false);
  assert.equal(await authorizeReviewer(await request({iss:'https://other-team.cloudflareaccess.com'}),env),false);
  assert.equal(await authorizeReviewer(await request({exp:now-1}),env),false);
  assert.equal(await authorizeReviewer(await request({email:undefined}),env),false);
  assert.equal(await authorizeReviewer(await request({email:' '}),env),false);
  assert.equal(await authorizeReviewer(await request({email:'reviewer@example.invalid '}),env),false);
  assert.equal(await authorizeReviewer(await request({email:'not an email'}),env),false);
  assert.equal(await authorizeReviewer(await request({type:'org'}),env),false);
  const unrelated=await generateKeyPair('RS256');
  assert.equal(await authorizeReviewer(await request({},unrelated.privateKey),env),false);
  assert.equal(remote.mock.callCount(),1);
  assert.equal(reviewerConfigured({...env,ACCESS_ISSUER:'https://other.example.invalid'}),false);
});
