import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function keyframes(css) {
  const found = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match;
  while ((match = re.exec(css))) {
    let index = re.lastIndex;
    let depth = 1;
    while (index < css.length && depth) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') depth -= 1;
      index += 1;
    }
    found.push([match[1], css.slice(re.lastIndex, index - 1)]);
  }
  return found;
}

test('candidate motion is one-shot and stays on transform, opacity, or the score ring', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /infinite/);
  assert.match(css, /animation-name:\s*ledger-settle/);
  assert.match(css, /--ledger-width:\s*100%/);
  assert.match(css, /--ledger-width:\s*65%/);
  assert.match(css, /--ledger-width:\s*35%/);
  assert.match(css, /--ledger-width:\s*15%/);
  assert.match(css, /--ledger-width:\s*20%/);
  const frames = keyframes(css);
  const names = frames.map(([name]) => name);
  for (const name of ['ledger-settle', 'banner-sweep', 'mark-in', 'surface-in', 'fade-in', 'bar-reveal', 'score-reveal']) {
    assert.ok(names.includes(name), name);
  }
  for (const [name, body] of frames) {
    for (const property of body.matchAll(/(^|[{;])\s*(--[a-z-]+|[a-z-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity', '--score-turn'].includes(property[2]), `${name} animates ${property[2]}`);
    }
  }
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(reduced, /animation-delay:\s*0s\s*!important/);
  assert.match(reduced, /transition-duration:\s*0\.01ms\s*!important/);
  assert.equal(reduced.includes('@media'), true);
});
