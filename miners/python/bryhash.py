"""
bryhash.py — Python port of Brycoin's BryHash v2 algorithm.

Must stay byte-for-byte identical (in output) to the JavaScript version
in index.js / index.html. All arithmetic is masked to 32 bits to match
JavaScript's >>> 0 behavior, since Python ints don't wrap on their own.
"""

MASK32 = 0xFFFFFFFF
BRYHASH_WORDS = 16
BRYHASH_ROUNDS_PER_CHAR = 4
BRYHASH_FINALIZE_PASSES = 3


def _rotl(x, r):
    x &= MASK32
    return ((x << r) | (x >> (32 - r))) & MASK32


def _imul(a, b):
    # Equivalent to JavaScript's Math.imul: 32-bit integer multiply, wrapped.
    return (a * b) & MASK32


def bryhash(input_str: str) -> str:
    state = [0] * BRYHASH_WORDS
    for i in range(BRYHASH_WORDS):
        state[i] = (0x9E3779B9 ^ _imul(i + 1, 0x85EBCA6B)) & MASK32

    for i, ch in enumerate(input_str):
        c = ord(ch)
        for r in range(BRYHASH_ROUNDS_PER_CHAR):
            idx = (i + r) % BRYHASH_WORDS
            nidx = (idx + 1) % BRYHASH_WORDS

            state[idx] = (state[idx] ^ c) & MASK32
            state[idx] = _imul(state[idx], 0x2545F491)
            state[idx] = _rotl(state[idx], 13)

            state[nidx] = (state[nidx] + state[idx]) & MASK32
            state[nidx] = _imul(state[nidx] ^ state[idx], 0x27D4EB2F)
            state[nidx] = _rotl(state[nidx], 7)

    for p in range(BRYHASH_FINALIZE_PASSES):
        for i in range(BRYHASH_WORDS):
            j = (i + 7) % BRYHASH_WORDS
            state[i] = _imul(state[i] ^ state[j], (0x1000193 + p) & MASK32)
            state[i] = _rotl(state[i], 11)

    return "".join(f"{w:08x}" for w in state)


def meets_difficulty(hash_hex: str, difficulty: int) -> bool:
    if difficulty <= 0:
        return True
    return hash_hex.startswith("0" * difficulty)


if __name__ == "__main__":
    # quick self-test
    print(bryhash("brycoin-genesis-block"))
