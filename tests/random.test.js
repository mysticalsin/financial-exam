import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPaperRng, createRandomBelow } from "../src/random.js";

function xorshift32(seed) {
  let state = seed >>> 0;
  return words => {
    for (let index = 0; index < words.length; index++) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      words[index] = state;
    }
  };
}

test("rejection sampling drops the incomplete 32-bit tail and batches fills", () => {
  const scripted = [[0xFFFFFFFF, 0], [1, 2]];
  let fills = 0;
  const randomBelow = createRandomBelow(words => {
    words.set(scripted[fills++]);
  }, 2);
  assert.deepEqual([randomBelow(3), randomBelow(3), randomBelow(3)], [0, 1, 2]);
  assert.equal(fills, 2);

  assert.throws(() => randomBelow(0), RangeError);
  assert.throws(() => randomBelow(1.5), RangeError);
  assert.throws(() => createRandomBelow(undefined, 0), RangeError);

  let defaultFills = 0;
  const batched = createRandomBelow(words => {
    defaultFills++;
    crypto.getRandomValues(words);
  });
  for (let draw = 0; draw < 80; draw++) assert.equal(batched(7) < 7, true);
  assert.equal(defaultFills, 2, "eighty small draws fit in two 64-word batches");
});

test("a fixed seed produces a stable residue histogram", () => {
  const randomBelow = createRandomBelow(xorshift32(0x12345678), 16);
  const counts = [0, 0, 0, 0, 0, 0];
  for (let draw = 0; draw < 6000; draw++) counts[randomBelow(6)]++;
  assert.deepEqual(counts, [986, 947, 1009, 976, 996, 1086]);
  const rng = createPaperRng(xorshift32(0x89abcdef), 8);
  assert.deepEqual(rng.shuffle(["only"]), ["only"]);
  const picked = rng.pickInt(28, 46);
  assert.equal(Number.isInteger(picked) && picked >= 28 && picked <= 46, true);
});

test("paper modules draw through the shared batch instead of one word per index", async () => {
  const bank = await readFile(new URL("../src/bank.js", import.meta.url), "utf8");
  const practice = await readFile(new URL("../src/practice.js", import.meta.url), "utf8");
  assert.match(bank, /createPaperRng\(\)/);
  assert.doesNotMatch(bank, /getRandomValues/);
  assert.match(practice, /createPaperRng\(\)/);
  assert.doesNotMatch(practice, /new Uint32Array\(1\)/);
});
