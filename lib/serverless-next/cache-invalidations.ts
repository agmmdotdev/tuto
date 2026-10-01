import { randomUUID } from "node:crypto";

// Data-cache tags include Next's implicit path tags. Prefetched Flight and
// retained layout models do not yet carry complete data dependency metadata,
// so a mutation conservatively invalidates the whole affected workspace.
export class NextCacheInvalidations {
  private workspaces = new Map<string, { version: string; pending: number }>();

  private state(workspaceKey: string) {
    let state = this.workspaces.get(workspaceKey);
    if (!state) state = { version: randomUUID(), pending: 0 };
    this.workspaces.delete(workspaceKey);
    this.workspaces.set(workspaceKey, state);
    // Keep active mutations until settlement. Evicting an idle workspace is
    // safe: its next random version forces existing artifacts to miss.
    for (const [key, entry] of this.workspaces) {
      if (this.workspaces.size <= 128) break;
      if (entry.pending === 0 && key !== workspaceKey) this.workspaces.delete(key);
    }
    return state;
  }

  version(workspaceKey: string) { return this.state(workspaceKey).version; }
  pending(workspaceKey: string) { return this.state(workspaceKey).pending > 0; }

  begin(workspaceKey: string) {
    const state = this.state(workspaceKey);
    state.version = randomUUID();
    state.pending++;
    return () => {
      // Also reject renders started during the mutation, including partial
      // adapter failures. Overlapping mutations must all settle before reuse.
      state.version = randomUUID();
      state.pending--;
    };
  }
}

const key = Symbol.for("tuto.serverless-next.cache-invalidations.v1");
const globals = globalThis as typeof globalThis & { [key]?: NextCacheInvalidations };
export const nextCacheInvalidations = globals[key] ??= new NextCacheInvalidations();
