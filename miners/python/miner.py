"""
miner.py — external Brycoin (BRY) miner.

Runs on any machine, on any network — it only needs HTTP(S) access to
your Brycoin server. Uses real OS processes (multiprocessing), not
threads, so it gets genuine parallel CPU usage across cores — Python's
GIL would otherwise prevent that with plain threads.

Usage:
    python miner.py --server http://euger-01.bagelhosting.net:20170 \\
        --username YOUR_USERNAME --password YOUR_PASSWORD \\
        --mode solo --threads 8

    python miner.py --server http://euger-01.bagelhosting.net:20170 \\
        --username YOUR_USERNAME --password YOUR_PASSWORD \\
        --mode pool --pool 2 --threads 8

See requirements.txt for the one dependency (requests).
"""

import argparse
import os
import time
from multiprocessing import Process, Queue, Event

import requests

from bryhash import bryhash, meets_difficulty


def worker_loop(prev_hash, height, difficulty, miner_tag, thread_index, thread_count,
                 result_queue, stop_event, rate_queue):
    nonce = thread_index
    batch = 0
    BATCH_REPORT = 1500
    while not stop_event.is_set():
        candidate = f"{prev_hash}{height}{nonce}{miner_tag}"
        h = bryhash(candidate)
        batch += 1
        if meets_difficulty(h, difficulty):
            try:
                result_queue.put((nonce, h))
            except Exception:
                pass
            return
        nonce += thread_count
        if batch >= BATCH_REPORT:
            rate_queue.put(batch)
            batch = 0
    if batch:
        rate_queue.put(batch)


class BrycoinMiner:
    def __init__(self, server, username, password, mode, pool, threads):
        self.server = server.rstrip("/")
        self.username = username
        self.password = password
        self.mode = mode
        self.pool = pool
        self.threads = threads
        self.token = None
        self.session = requests.Session()

    def login(self):
        r = self.session.post(
            f"{self.server}/api/login",
            json={"username": self.username, "password": self.password},
            timeout=15,
        )
        r.raise_for_status()
        self.token = r.json()["token"]
        print(f"Logged in as {self.username}")

    def headers(self):
        return {"Authorization": f"Bearer {self.token}"}

    def fetch_job(self):
        params = {"mode": self.mode}
        if self.mode == "pool":
            params["pool"] = self.pool
        r = self.session.get(f"{self.server}/api/job", headers=self.headers(), params=params, timeout=15)
        r.raise_for_status()
        return r.json()

    def submit(self, job, nonce, hash_hex):
        payload = {
            "mode": self.mode,
            "pool": self.pool if self.mode == "pool" else None,
            "nonce": nonce,
            "hash": hash_hex,
            "height": job["height"],
            "prevHash": job["prevHash"],
        }
        r = self.session.post(f"{self.server}/api/submit", headers=self.headers(), json=payload, timeout=15)
        return r

    def heartbeat(self, hashrate):
        try:
            self.session.post(
                f"{self.server}/api/heartbeat",
                headers=self.headers(),
                json={
                    "mode": self.mode,
                    "pool": self.pool if self.mode == "pool" else None,
                    "hashrate": hashrate,
                },
                timeout=10,
            )
        except Exception:
            pass  # heartbeat is just for the dashboard's display - never worth crashing over

    def run(self):
        self.login()
        pool_note = f" pool {self.pool}" if self.mode == "pool" else ""
        print(f"Mining {self.mode}{pool_note} with {self.threads} process(es) against {self.server}")

        last_heartbeat = 0.0
        current_hashrate = 0

        while True:
            try:
                job = self.fetch_job()
            except Exception as e:
                print(f"Couldn't fetch a job ({e}), retrying in 5s...")
                time.sleep(5)
                continue

            result_queue = Queue()
            rate_queue = Queue()
            stop_event = Event()
            procs = [
                Process(
                    target=worker_loop,
                    args=(job["prevHash"], job["height"], job["difficulty"], job["minerTag"],
                          i, self.threads, result_queue, stop_event, rate_queue),
                    daemon=True,
                )
                for i in range(self.threads)
            ]
            for p in procs:
                p.start()

            total_hashes = 0
            window_start = time.time()
            last_job_check = time.time()
            found = None

            while found is None:
                try:
                    found = result_queue.get(timeout=0.5)
                except Exception:
                    found = None

                while True:
                    try:
                        total_hashes += rate_queue.get_nowait()
                    except Exception:
                        break

                now = time.time()
                if now - window_start >= 1.0:
                    current_hashrate = int(total_hashes / (now - window_start))
                    print(f"\r{current_hashrate:,} H/s   ", end="", flush=True)
                    total_hashes = 0
                    window_start = now

                if now - last_heartbeat >= 4:
                    self.heartbeat(current_hashrate)
                    last_heartbeat = now

                if found is None and now - last_job_check >= 5:
                    last_job_check = now
                    try:
                        current = self.fetch_job()
                        if current["height"] != job["height"] or current["prevHash"] != job["prevHash"]:
                            print("\nRound changed — restarting with a fresh job.")
                            break
                    except Exception:
                        pass  # network hiccup, keep mining the job we already have

            stop_event.set()
            for p in procs:
                p.terminate()
            for p in procs:
                p.join(timeout=2)

            if found is None:
                continue  # the round moved on without us - loop back and fetch a fresh job

            nonce, hash_hex = found
            print(f"\nFound a candidate for height {job['height']} — submitting...")
            try:
                r = self.submit(job, nonce, hash_hex)
                data = r.json()
                if r.status_code == 200:
                    print(f"✅ Block #{data['height']} accepted! Reward: {data.get('reward')} BRY")
                elif data.get("error") == "stale-job":
                    print("Someone else got there first — fetching a new job.")
                else:
                    print(f"Submission rejected: {data}")
            except Exception as e:
                print(f"Submit failed: {e}")


def main():
    parser = argparse.ArgumentParser(description="External Brycoin (BRY) miner")
    parser.add_argument("--server", required=True,
                         help="Brycoin server base URL, e.g. http://euger-01.bagelhosting.net:20170")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--mode", choices=["solo", "pool"], default="solo")
    parser.add_argument("--pool", type=int, choices=[1, 2, 3], default=1)
    parser.add_argument("--threads", type=int, default=None,
                         help="Number of processes to mine with (default: your CPU core count)")
    args = parser.parse_args()

    threads = args.threads or os.cpu_count() or 1
    threads = max(1, min(128, threads))

    miner = BrycoinMiner(args.server, args.username, args.password, args.mode, args.pool, threads)
    try:
        miner.run()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
