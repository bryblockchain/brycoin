/**
 * bryhash.js — the exact same BryHash v2 algorithm as index.js.
 * Kept as its own module so both the main miner process and every
 * worker_threads worker can require() the identical implementation.
 */

const BRYHASH_WORDS = 16;
const BRYHASH_ROUNDS_PER_CHAR = 4;
const BRYHASH_FINALIZE_PASSES = 3;

function bryHash(input) {
  const state = new Array(BRYHASH_WORDS);
  for (let i = 0; i < BRYHASH_WORDS; i++) {
    state[i] = (0x9e3779b9 ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  }

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    for (let r = 0; r < BRYHASH_ROUNDS_PER_CHAR; r++) {
      const idx = (i + r) % BRYHASH_WORDS;
      const nidx = (idx + 1) % BRYHASH_WORDS;
      state[idx] = (state[idx] ^ c) >>> 0;
      state[idx] = Math.imul(state[idx], 0x2545f491) >>> 0;
      state[idx] = ((state[idx] << 13) | (state[idx] >>> 19)) >>> 0;
      state[nidx] = (state[nidx] + state[idx]) >>> 0;
      state[nidx] = Math.imul(state[nidx] ^ state[idx], 0x27d4eb2f) >>> 0;
      state[nidx] = ((state[nidx] << 7) | (state[nidx] >>> 25)) >>> 0;
    }
  }

  for (let pass = 0; pass < BRYHASH_FINALIZE_PASSES; pass++) {
    for (let i = 0; i < BRYHASH_WORDS; i++) {
      const j = (i + 7) % BRYHASH_WORDS;
      state[i] = Math.imul(state[i] ^ state[j], 0x1000193 + pass) >>> 0;
      state[i] = ((state[i] << 11) | (state[i] >>> 21)) >>> 0;
    }
  }

  return state.map((x) => x.toString(16).padStart(8, "0")).join("");
}

function meetsDifficulty(hash, difficulty) {
  if (difficulty <= 0) return true;
  return hash.startsWith("0".repeat(difficulty));
}

module.exports = { bryHash, meetsDifficulty };
