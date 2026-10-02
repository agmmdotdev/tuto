import { randomUUID } from "node:crypto";

export type NextCacheDependencies = { complete: boolean; tags: string[] };
export type NextCacheSnapshot = { generation: string; sequence: number };
type Mutation = { sequence: number; tags?: string[] };
type State = {
  version: string;
  generation: string;
  sequence: number;
  pending: number;
  mutations: Mutation[];
};

// Keep a bounded journal. Missing metadata or history always forces a miss.
export class NextCacheInvalidations {
  private workspaces = new Map<string, State>();

  private state(workspaceKey: string) {
    let state = this.workspaces.get(workspaceKey);
    if (!state)
      state = {
        version: randomUUID(),
        generation: randomUUID(),
        sequence: 0,
        pending: 0,
        mutations: [],
      };
    this.workspaces.delete(workspaceKey);
    this.workspaces.set(workspaceKey, state);
    for (const [key, entry] of this.workspaces) {
      if (this.workspaces.size <= 128) break;
      if (entry.pending === 0 && key !== workspaceKey)
        this.workspaces.delete(key);
    }
    return state;
  }

  version(workspaceKey: string) {
    return this.state(workspaceKey).version;
  }
  generation(workspaceKey: string) {
    return this.state(workspaceKey).generation;
  }
  pending(workspaceKey: string) {
    return this.state(workspaceKey).pending > 0;
  }
  snapshot(workspaceKey: string): NextCacheSnapshot {
    const state = this.state(workspaceKey);
    return { generation: state.generation, sequence: state.sequence };
  }
  valid(
    workspaceKey: string,
    snapshot: NextCacheSnapshot,
    dependencies?: NextCacheDependencies,
  ) {
    const state = this.state(workspaceKey);
    if (
      state.pending ||
      snapshot.generation !== state.generation ||
      snapshot.sequence > state.sequence
    )
      return false;
    if (snapshot.sequence === state.sequence) return true;
    if (
      !dependencies?.complete ||
      !Array.isArray(dependencies.tags) ||
      !dependencies.tags.length ||
      dependencies.tags.length > 256 ||
      dependencies.tags.some(
        (tag) => typeof tag !== "string" || tag.length > 2048,
      )
    )
      return false;
    if (
      !state.mutations.length ||
      snapshot.sequence < state.mutations[0].sequence - 1
    )
      return false;
    const tags = new Set(dependencies.tags);
    return !state.mutations.some(
      (mutation) =>
        mutation.sequence > snapshot.sequence &&
        (!mutation.tags || mutation.tags.some((tag) => tags.has(tag))),
    );
  }
  begin(workspaceKey: string, tags?: string[]) {
    const state = this.state(workspaceKey);
    const bounded =
      tags?.length &&
      tags.length <= 256 &&
      tags.every((tag) => typeof tag === "string" && tag.length <= 2048)
        ? [...new Set(tags)]
        : undefined;
    const record = () => {
      state.version = randomUUID();
      // Unknown mutations also advance artifact epochs; scoped mutations use
      // the journal for full Flight and still invalidate every shell receipt.
      if (!bounded) {
        state.generation = randomUUID();
        state.mutations = [];
      }
      state.mutations.push({ sequence: ++state.sequence, tags: bounded });
      if (state.mutations.length > 128) state.mutations.shift();
    };
    record();
    state.pending++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      // Fence renders started during a mutation, including partial failures.
      record();
      state.pending--;
    };
  }
}

const key = Symbol.for("tuto.serverless-next.cache-invalidations.v2");
const globals = globalThis as typeof globalThis & {
  [key]?: NextCacheInvalidations;
};
export const nextCacheInvalidations = (globals[key] ??=
  new NextCacheInvalidations());
