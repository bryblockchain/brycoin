# Brycoin External Miners

Two standalone miners you can run on any machine, on any network —
they only need HTTP(S) access to your Brycoin server (e.g.
`http://euger-01.bagelhosting.net:20170`). Neither needs to be on the
same box or network as the server itself.

Both implement the exact same BryHash v2 algorithm as `index.js` /
`index.html`, log in over the API, fetch the current mining round,
search for a valid nonce using real multi-core parallelism, submit
solutions, and send periodic hashrate heartbeats so you show up on the
dashboard and pool stats like any browser miner.

## Python (`python/`)

Requires Python 3.8+.

```
cd python
pip install -r requirements.txt
python miner.py --server http://euger-01.bagelhosting.net:20170 \
  --username YOUR_USERNAME --password YOUR_PASSWORD \
  --mode solo --threads 8
```

For pool mining:
```
python miner.py --server http://euger-01.bagelhosting.net:20170 \
  --username YOUR_USERNAME --password YOUR_PASSWORD \
  --mode pool --pool 2 --threads 8
```

`--threads` defaults to your CPU's core count if omitted. Uses
`multiprocessing` (real OS processes) rather than threads, since
Python's GIL would otherwise prevent genuine parallel hashing.

## Node.js (`node/`)

Requires Node.js 18+. No `npm install` needed — zero dependencies,
just built-in `fetch` and `worker_threads`.

```
cd node
node miner.js --server http://euger-01.bagelhosting.net:20170 \
  --username YOUR_USERNAME --password YOUR_PASSWORD \
  --mode solo --threads 8
```

Same flags as the Python version. Uses `worker_threads` for genuine
parallel CPU usage across cores.

## Notes

- Both miners poll the server every 5 seconds to detect if someone
  else has already solved the current round, and restart on a fresh
  job automatically — no manual restarting needed.
- `Ctrl+C` stops either one cleanly.
- If your server is plain `http://` (not `https://`), that's fine for
  these command-line miners — the mixed-content restriction that
  affects browsers doesn't apply here.
- Keep your account password out of shell history / scripts you share
  — consider setting it via an environment variable and reading it
  from there if you plan to automate this on a shared machine.
