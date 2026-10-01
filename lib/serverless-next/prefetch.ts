import { createHash, randomBytes } from "node:crypto";
import type { NextRequestArtifact } from "./artifact";
import type { NextRouterState } from "./navigation";
import { nextCacheInvalidations } from "./cache-invalidations";

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
  private segments = new Map<string, {artifact:NextRequestArtifact;owner:string;context:string;keys:string[];slots:Map<string,string[]>;expiresAt:number}>();
  private epochs = new WeakMap<NextRequestArtifact, number>();
  private workspaceVersions = new WeakMap<NextRequestArtifact, string>();
  readonly ttlMs = 30_000;
  readonly maxEntryBytes = 1024 * 1024;
  constructor(private now: () => number = Date.now) {}
  epoch(artifact: NextRequestArtifact) {
    const version = nextCacheInvalidations.version(artifact.workspaceKey);
    const previous = this.workspaceVersions.get(artifact);
    this.workspaceVersions.set(artifact, version);
    if (previous !== undefined && previous !== version) {
      this.epochs.set(artifact, (this.epochs.get(artifact) ?? 0) + 1);
      this.drop(artifact);
    }
    return this.epochs.get(artifact) ?? 0;
  }
  invalidate(artifact: NextRequestArtifact) {
    this.epochs.set(artifact, this.epoch(artifact) + 1);
    this.drop(artifact);
  }
  private drop(artifact: NextRequestArtifact) {
    for (const [ticket, entry] of this.entries) if (entry.artifact === artifact) this.entries.delete(ticket);
    for (const [token, entry] of this.segments) if (entry.artifact === artifact) this.segments.delete(token);
  }
  segmentContext(artifact:NextRequestArtifact, owner:string, headers:Record<string,string>) {
    return createHash("sha256").update(nextPrefetchKey(artifact.revision, "/", headers))
      .update(JSON.stringify([artifact.generation,owner,this.epoch(artifact)])).digest("hex");
  }
  // Only the API's completed, bounded, error-free shell renderer issues receipts.
  issueSegments(artifact:NextRequestArtifact, owner:string, headers:Record<string,string>, segments:Array<{key:string;slots:string[]}>) {
    if (nextCacheInvalidations.pending(artifact.workspaceKey)) return undefined;
    const context=this.segmentContext(artifact,owner,headers);
    const selected=[...new Set(segments.filter(item=>item.slots.length<=64).map(item=>item.key))].filter(key=>key.startsWith(context+":")&&key.length<=4096).slice(0,16);
    const slots=new Map(segments.filter(item=>selected.includes(item.key)).map(item=>[item.key,item.slots]));
    if (!selected.length) return undefined;
    for (const [token,entry] of this.segments) if(entry.expiresAt<=this.now())this.segments.delete(token);
    const owned=[...this.segments].filter(([,entry])=>entry.artifact===artifact&&entry.owner===owner);
    while(owned.length>=8)this.segments.delete(owned.shift()![0]);
    while(this.segments.size>=128)this.segments.delete(this.segments.keys().next().value!);
    const token=randomBytes(24).toString("base64url");
    this.segments.set(token,{artifact,owner,context,keys:selected,slots,expiresAt:this.now()+this.ttlMs});
    return {token,keys:selected,ttlMs:this.ttlMs};
  }
  resolveSegments(artifact:NextRequestArtifact, owner:string, headers:Record<string,string>, refs:unknown) {
    if (nextCacheInvalidations.pending(artifact.workspaceKey)) return [];
    if(!Array.isArray(refs)||refs.length>8)return [];
    const context=this.segmentContext(artifact,owner,headers),keys=new Map<string,string[]>();
    for(const ref of refs){
      if(!ref||typeof ref.token!=="string"||!Array.isArray(ref.keys)||ref.keys.length>16)continue;
      const entry=this.segments.get(ref.token);
      if(!entry||entry.artifact!==artifact||entry.owner!==owner||entry.context!==context||entry.expiresAt<=this.now())continue;
      for(const key of ref.keys)if(typeof key==="string"&&entry.keys.includes(key)&&keys.size<16)keys.set(key,entry.slots.get(key) ?? []);
    }
    return [...keys].map(([key,slots])=>({key,slots}));
  }
  put(entry: Omit<Entry, "expiresAt">) {
    if (entry.epoch !== this.epoch(entry.artifact) || nextCacheInvalidations.pending(entry.artifact.workspaceKey) || entry.body.byteLength > this.maxEntryBytes) return null;
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
    return entry.expiresAt > this.now() && entry.epoch === this.epoch(artifact) && !nextCacheInvalidations.pending(artifact.workspaceKey) ? entry : null;
  }
}

const key = Symbol.for("tuto.serverless-next.prefetch.v1");
const globals = globalThis as typeof globalThis & {[key]?: NextPrefetchTickets};
export const nextPrefetchTickets = globals[key] ??= new NextPrefetchTickets();
