// Unbiased integers from a batched CSPRNG.
// Each paper draws from its own buffer. A Workers isolate reuses module scope, so this
// helper does not keep a process-wide cursor or leftover words between requests.

const RANGE = 4294967296;

export function createRandomBelow(fill = array => crypto.getRandomValues(array), batch = 64) {
  if (!Number.isInteger(batch) || batch < 1) throw new RangeError("Random batch is outside the supported range.");
  const words = new Uint32Array(batch);
  let index = batch;
  return function randomBelow(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > RANGE) {
      throw new RangeError("Random bound is outside the supported range.");
    }
    // Reject the incomplete tail so modulo does not prefer low residues.
    const cutoff = RANGE - (RANGE % limit);
    let word;
    do {
      if (index >= words.length) {
        fill(words);
        index = 0;
      }
      word = words[index++];
    } while (word >= cutoff);
    return word % limit;
  };
}

export function createPaperRng(fill, batch) {
  const randomBelow = createRandomBelow(fill, batch);
  return {
    randomBelow,
    pick(values) {
      return values[randomBelow(values.length)];
    },
    pickInt(minimum, maximum, step = 1) {
      return minimum + randomBelow((maximum - minimum) / step + 1) * step;
    },
    shuffle(values) {
      const result = [...values];
      for (let i = result.length - 1; i > 0; i--) {
        const j = randomBelow(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },
  };
}
