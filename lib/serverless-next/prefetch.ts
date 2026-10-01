import { randomBytes } from "node:crypto";
import type { NextRequestArtifact } from "./artifact";
import type { NextRouterState } from "./navigation";

// Standalone so the hydration transport can embed exactly the same key logic.
export function nextPrefetchKey(revision: string, url: string, headers: Record<string, string>, state?: NextRouterState, mode: "full" | "auto" = "full") {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "navigationId").sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  const target = new URL(url, "http://next.local");
  return JSON.stringify(canonical([revision, target.pathname + target.search,
    Object.fromEntries(new Headers(headers).entries()), state ?? null, mode]));
}

type Entry = {
  artifact: NextRequestArtifact;
  owner: string;
  key: string;
  epoch: number;
  expiresAt: number;
  body: Uint8Array;
  headers: Array<[string, string]>;
  status: number;
  kind?: "full" | "shell";
};

export class NextPrefetchTickets {
  private entries = new Map<string, Entry>();
  private epochs = new WeakMap<NextRequestArtifact, number>();
  readonly ttlMs = 30_000;
  readonly maxEntryBytes = 1024 * 1024;
  constructor(private now: () => number = Date.now) {}
  epoch(artifact: NextRequestArtifact) { return this.epochs.get(artifact) ?? 0; }
  invalidate(artifact: NextRequestArtifact) {
    this.epochs.set(artifact, this.epoch(artifact) + 1);
    for (const [ticket, entry] of this.entries) if (entry.artifact === artifact) this.entries.delete(ticket);
  }
  put(entry: Omit<Entry, "expiresAt">) {
    if (entry.epoch !== this.epoch(entry.artifact) || entry.body.byteLength > this.maxEntryBytes) return null;
    for (const [ticket, item] of this.entries) if (item.expiresAt <= this.now() ||
      (item.artifact === entry.artifact && item.owner === entry.owner && item.key === entry.key)) this.entries.delete(ticket);
    // Eight entries per document; at most sixteen MiB process-wide.
    const owned = [...this.entries].filter(([, item]) => item.artifact === entry.artifact && item.owner === entry.owner);
    while (owned.length >= 8) this.entries.delete(owned.shift()![0]);
    let bytes = [...this.entries.values()].reduce((sum, item) => sum + item.body.byteLength, 0);
    while (this.entries.size >= 128 || bytes + entry.body.byteLength > 16 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      bytes -= this.entries.get(oldest)!.body.byteLength;
      this.entries.delete(oldest);
    }
    const ticket = randomBytes(24).toString("base64url");
    this.entries.set(ticket, {...entry, expiresAt:this.now() + this.ttlMs});
    return ticket;
  }
  take(ticket: string, artifact: NextRequestArtifact, owner: string, key: string) {
    const entry = this.entries.get(ticket);
    if (!entry || entry.artifact !== artifact || entry.owner !== owner || entry.key !== key) return null;
    this.entries.delete(ticket);
    return entry.expiresAt > this.now() && entry.epoch === this.epoch(artifact) ? entry : null;
  }
}

const key = Symbol.for("tuto.serverless-next.prefetch.v1");
const globals = globalThis as typeof globalThis & {[key]?: NextPrefetchTickets};
export const nextPrefetchTickets = globals[key] ??= new NextPrefetchTickets();
