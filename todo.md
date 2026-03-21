# TODO

## Monaco On-Demand Type Loading

- Keep a tiny base preload for `/serverless`:
  - `react`
  - `react/jsx-runtime`
  - `react/jsx-dev-runtime`
  - `react-dom`
  - `react-dom/client`

- Replace the fixed broad type fetch with import-driven loading:
  - scan workspace files for bare package imports and subpath imports
  - build a normalized requested package set like `motion/react` or `zod`
  - request only missing type libraries from the server
  - cache already loaded libraries in the client session

- Add a package-specific lazy strategy:
  - keep `lucide-react` as a generated lightweight stub
  - keep real `motion/react` types
  - use real package types for other libraries unless payload size becomes a problem

- Extend the types API:
  - accept requested package specifiers instead of only a fixed seed list
  - resolve package entrypoints and subpath types safely on the server
  - return only the declaration graph needed for the requested specifiers

- Improve Monaco integration:
  - inject new libs with `addExtraLib(...)` only when imports change
  - dedupe previously registered libs
  - invalidate libs when a package import is removed only if nothing else still needs it

- Add fallback loading:
  - when Monaco reports `Cannot find module "..."`, request that package on demand
  - avoid blocking normal editing while the fetch is in flight

- Add observability:
  - log which packages are requested
  - measure type payload bytes per request
  - track how much this reduces `/api/serverless/types` response size

## Serverless Express Hardening

- Document the current trust model clearly:
  - `/serverless/expressjs` runs user code in a real child Node process
  - this is acceptable for trusted/demo use only
  - this is not a safe public untrusted-code sandbox

- Reduce the runtime attack surface:
  - add a runtime import allowlist for `express` and other explicitly approved packages
  - block Node builtins like `fs`, `net`, `tls`, `child_process`, `worker_threads`, and `cluster`
  - prevent accidental access to repo-only server modules

- Add execution limits:
  - hard timeout for the child runner
  - request/response body size limits
  - stdout/stderr/log size caps
  - concurrency limits so repeated requests cannot fan out uncontrollably

- Review secret and environment exposure:
  - make sure user code cannot access sensitive env vars intended for the host app
  - avoid passing host secrets into the runner environment unless strictly required

- Restrict network behavior:
  - decide whether outbound network access should be blocked entirely
  - if not blocked, add an allowlist and log outbound access attempts

- Plan for real isolation later:
  - move untrusted Express execution behind Secure Exec or another sandbox boundary
  - keep the current stateless route as a trusted/internal mode until that exists
