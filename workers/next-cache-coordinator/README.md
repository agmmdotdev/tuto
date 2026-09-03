# Tuto Next cache coordinator

This Worker is the production metadata half of Tuto's durable Next cache. It
routes every workspace to a separate SQLite-backed Durable Object. That object
serializes mutation sequence allocation, tag invalidation, and writer leases;
the much larger cache value envelopes remain in R2.

## Deploy

From the repository root:

```bash
corepack yarn wrangler secret put TUTO_NEXT_CACHE_COORDINATOR_TOKEN \
  --config workers/next-cache-coordinator/wrangler.jsonc
corepack yarn deploy:next-cache-coordinator
```

The first deploy applies the `v1` `new_sqlite_classes` migration. Configure the
Vercel runtime with the deployed `/v1` URL and the same secret:

```dotenv
TUTO_NEXT_CACHE_COORDINATOR_ENDPOINT=https://tuto-next-cache-coordinator.example.workers.dev/v1
TUTO_NEXT_CACHE_COORDINATOR_TOKEN=...
```

The public `GET /health` route does not read or mutate a Durable Object. All
`POST /v1` requests require the Bearer token. The outer Worker hashes the
workspace key and selects one object with `getByName`, so different students do
not contend on a global object.

## Local smoke and load test

Create `workers/next-cache-coordinator/.dev.vars` locally (it is ignored by
git):

```dotenv
TUTO_NEXT_CACHE_COORDINATOR_TOKEN=local-development-token
```

Start the local Worker and run the protocol load test in another terminal:

```bash
corepack yarn dev:next-cache-coordinator
TUTO_NEXT_CACHE_COORDINATOR_ENDPOINTS=http://localhost:8787/v1 \
TUTO_NEXT_CACHE_COORDINATOR_TOKEN=local-development-token \
  corepack yarn load:next-cache-coordinator
```

For an actual multi-region check, pass comma-separated ingress URLs that route
to the same deployed Worker. The script round-robins requests across them and
reports the Cloudflare colos observed in `CF-Ray` response headers:

```bash
TUTO_NEXT_CACHE_COORDINATOR_ENDPOINTS=https://region-a.example/v1,https://region-b.example/v1 \
TUTO_NEXT_CACHE_COORDINATOR_TOKEN=... \
  corepack yarn load:next-cache-coordinator --concurrency=64 --allocations=500 \
    --min-colos=2
```

It fails if concurrent allocations are not monotonic, if more than one writer
wins a contended lease, if an invalidation fails to fence an older writer, or
if fewer than the requested number of `CF-Ray` colos are observed. Different
hostnames alone do not create a multi-region test: the ingress URLs must be
geographically pinned proxies/runners, or this command must be executed by a
load service in multiple regions against the same Worker.

## R2 cleanup

The included lifecycle file expires cache envelopes under `next/cache/v1/`
after seven days and aborts incomplete multipart uploads after one day:

```bash
corepack yarn wrangler r2 bucket lifecycle set tuto-next-cache \
  --file workers/next-cache-coordinator/r2-lifecycle.json
```

`lifecycle set` replaces the bucket's complete lifecycle configuration. Use a
dedicated cache bucket, or merge these rules with existing rules before applying
the file.

Expiration is operational compaction, not cache correctness. If a still-valid
object expires, the next request is a miss and recomputes it. Invalidation
ordering remains in the Durable Object. Change the retention period to match
the longest useful lifetime of a Tuto workspace before applying the file.

## Local result

With the compiled Worker running in `workerd` against a real SQLite Durable
Object, the 200-allocation/32-concurrency probe completed 237 total protocol
requests at 239 allocation requests/second. Latency was 52 ms p50, 420 ms p95,
and 424 ms p99. All monotonicity, contention, reacquisition, and fencing checks
passed. This is a local correctness/contention result, not a Cloudflare regional
latency claim; the p95 also reflects intentional serialization of mutations to
one workspace object.
