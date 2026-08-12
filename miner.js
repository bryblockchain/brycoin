/**
 * miner.js — external Brycoin (BRY) miner.
 *
 * Runs on any machine, on any network — it only needs HTTP(S) access to
 * your Brycoin server. Uses worker_threads (built into Node, no extra
 * dependency) for genuine parallel CPU usage across cores.
 *
 * Usage:
 *   node miner.js --server http://euger-01.bagelhosting.net:20170 \
 *     --username YOUR_USERNAME --password YOUR_PASSWORD \
 *     --mode solo --threads 8
 *
 *   node miner.js --server http://euger-01.bagelhosting.net:20170 \
 *     --username YOUR_USERNAME --password YOUR_PASSWORD \
 *     --mode pool --pool 2 --threads 8
 *
 * Requires Node.js 18+ (for built-in fetch). No npm install needed.
 */

const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");

function parseArgs() {
  const args = { mode: "solo", pool: 1, threads: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (["server", "username", "password", "mode"].includes(key)) {
      args[key] = val;
      i++;
    } else if (key === "pool" || key === "threads") {
      args[key] = parseInt(val, 10);
      i++;
    }
  }
  if (!args.server || !args.username || !args.password) {
    console.error("Usage: node miner.js --server <url> --username <name> --password <pass> [--mode solo|pool] [--pool 1-3] [--threads N]");
    process.exit(1);
  }
  if (!args.threads) args.threads = os.cpus().length || 1;
  args.threads = Math.max(1, Math.min(128, args.threads));
  return args;
}

class BrycoinMiner {
  constructor({ server, username, password, mode, pool, threads }) {
    this.server = server.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.mode = mode;
    this.pool = pool;
    this.threads = threads;
    this.token = null;
  }

  async login() {
    const res = await fetch(`${this.server}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    this.token = data.token;
    console.log(`Logged in as ${this.username}`);
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  async fetchJob() {
    const qs = this.mode === "pool" ? `?mode=pool&pool=${this.pool}` : `?mode=solo`;
    const res = await fetch(`${this.server}/api/job${qs}`, { headers: this.authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to fetch job");
    return data;
  }

  async submit(job, nonce, hash) {
    const res = await fetch(`${this.server}/api/submit`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        mode: this.mode,
        pool: this.mode === "pool" ? this.pool : null,
        nonce,
        hash,
        height: job.height,
        prevHash: job.prevHash,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async heartbeat(hashrate) {
    try {
      await fetch(`${this.server}/api/heartbeat`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ mode: this.mode, pool: this.mode === "pool" ? this.pool : null, hashrate }),
      });
    } catch (e) {
      // heartbeat is just for the dashboard's display - never worth crashing over
    }
  }

  spawnWorkers(job) {
    const workerPath = path.join(__dirname, "mine-worker.js");
    this.workers = [];
    this.currentHashrate = 0;
    return new Promise((resolve) => {
      let settled = false;
      for (let i = 0; i < this.threads; i++) {
        const w = new Worker(workerPath, {
          workerData: {
            prevHash: job.prevHash,
            height: job.height,
            difficulty: job.difficulty,
            minerTag: job.minerTag,
            threadIndex: i,
            threadCount: this.threads,
          },
        });
        w.on("message", (msg) => {
          if (msg.type === "rate") {
            this._rateAccum = (this._rateAccum || 0) + msg.count;
          } else if (msg.type === "found" && !settled) {
            settled = true;
            resolve({ nonce: msg.nonce, hash: msg.hash });
          }
        });
        w.on("error", (err) => console.error("Worker error:", err.message));
        this.workers.push(w);
      }
    });
  }

  stopWorkers() {
    for (const w of this.workers || []) {
      w.postMessage({ type: "stop" });
      w.terminate().catch(() => {});
    }
    this.workers = [];
  }

  async run() {
    await this.login();
    const poolNote = this.mode === "pool" ? ` pool ${this.pool}` : "";
    console.log(`Mining ${this.mode}${poolNote} with ${this.threads} worker thread(s) against ${this.server}`);

    let lastHeartbeat = 0;

    while (true) {
      let job;
      try {
        job = await this.fetchJob();
      } catch (e) {
        console.error(`Couldn't fetch a job (${e.message}), retrying in 5s...`);
        await sleep(5000);
        continue;
      }

      this._rateAccum = 0;
      const resultPromise = this.spawnWorkers(job);

      let found = null;
      const rateTimer = setInterval(() => {
        const rate = this._rateAccum || 0;
        this._rateAccum = 0;
        this.currentHashrate = rate;
        process.stdout.write(`\r${rate.toLocaleString()} H/s   `);
      }, 1000);

      const heartbeatTimer = setInterval(() => {
        this.heartbeat(this.currentHashrate || 0);
      }, 4000);

      const jobCheckTimer = setInterval(async () => {
        try {
          const current = await this.fetchJob();
          if (current.height !== job.height || current.prevHash !== job.prevHash) {
            console.log("\nRound changed — restarting with a fresh job.");
            clearInterval(jobCheckTimer);
            this.stopWorkers();
          }
        } catch (e) {
          // network hiccup, keep mining the job we already have
        }
      }, 5000);

      found = await Promise.race([
        resultPromise,
        new Promise((resolve) => {
          const check = setInterval(() => {
            if ((this.workers || []).length === 0) {
              clearInterval(check);
              resolve(null); // workers were stopped because the round changed
            }
          }, 200);
        }),
      ]);

      clearInterval(rateTimer);
      clearInterval(heartbeatTimer);
      clearInterval(jobCheckTimer);
      this.stopWorkers();

      if (!found) continue; // round moved on without us

      console.log(`\nFound a candidate for height ${job.height} — submitting...`);
      try {
        const { status, data } = await this.submit(job, found.nonce, found.hash);
        if (status === 200) {
          console.log(`✅ Block #${data.height} accepted! Reward: ${data.reward} BRY`);
        } else if (data.error === "stale-job") {
          console.log("Someone else got there first — fetching a new job.");
        } else {
          console.log("Submission rejected:", data);
        }
      } catch (e) {
        console.log("Submit failed:", e.message);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs();
  const miner = new BrycoinMiner(args);
  try {
    await miner.run();
  } catch (e) {
    console.error("Fatal error:", e.message);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  console.log("\nStopped.");
  process.exit(0);
});

main();
