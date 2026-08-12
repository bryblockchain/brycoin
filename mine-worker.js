/**
 * mine-worker.js — one worker_threads worker. Each one mines a disjoint
 * slice of the nonce space (nonce = threadIndex, threadIndex+threadCount,
 * threadIndex+2*threadCount, ...) so N workers never duplicate work.
 *
 * worker_threads gives genuine OS-level parallelism across CPU cores,
 * unlike a single Node process which is single-threaded for JS execution.
 */

const { parentPort, workerData } = require("worker_threads");
const { bryHash, meetsDifficulty } = require("./bryhash");

const { prevHash, height, difficulty, minerTag, threadIndex, threadCount } = workerData;

let running = true;
parentPort.on("message", (msg) => {
  if (msg && msg.type === "stop") running = false;
});

function step() {
  if (!running) return;
  const BATCH = 2000;
  let nonce = step.nonce;
  let batch = 0;
  for (let i = 0; i < BATCH; i++) {
    const candidate = `${prevHash}${height}${nonce}${minerTag}`;
    const h = bryHash(candidate);
    batch++;
    if (meetsDifficulty(h, difficulty)) {
      running = false;
      parentPort.postMessage({ type: "found", nonce, hash: h });
      return;
    }
    nonce += threadCount;
  }
  step.nonce = nonce;
  parentPort.postMessage({ type: "rate", count: batch });
  setImmediate(step);
}
step.nonce = threadIndex;
step();
