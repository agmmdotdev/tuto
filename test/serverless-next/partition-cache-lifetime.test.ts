import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { getNextCacheAdapter, readNextCacheValue, writeNextCacheValue, revalidateNextCacheTags,
  type NextCacheGetInput, type NextCacheSetInput, type NextCacheLockInput, type NextCacheLock, type NextCacheRevalidateInput, type NextCacheMetrics } from "../../lib/serverless-next/cache-adapter";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import { closeNextRscWorkerPoolForTests } from "../../lib/serverless-next/rsc-worker-pool";
import { closeNextSsrWorkerPoolForTests } from "../../lib/serverless-next/ssr-worker-pool";
import { cacheLifetimeParityWorkspace } from "./fixtures/cache-lifetime-parity-workspace";

afterAll(async () => { await closeNextRscWorkerPoolForTests(); await closeNextSsrWorkerPoolForTests(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type ProbeResult = { value: { id: string; value: number }; metrics: NextCacheMetrics };
type Message = { type: string; id: string; result: ProbeResult; error?: string;
  operation: string; input: unknown; requestId: string };

for (const clock of ["native", "frozen"]) {
  test(`${clock} clock: real Next coarse/specific writes retain host deadlines and isolate root partitions`, async () => {
    const child = fork(fileURLToPath(new URL("./fixtures/partition-cache-handler-probe.cjs", import.meta.url)), [], {
      execArgv: ["--conditions=react-server"], env: { ...process.env, NODE_ENV: "production", TUTO_PARTITION_PROBE_CLOCK: clock,
        NODE_PATH: [process.env.NODE_PATH, resolve("node_modules/next/dist/compiled")].filter(Boolean).join(delimiter) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const pending = new Map<string, { resolve: (value: ProbeResult) => void; reject: (error: Error) => void }>();
    const writes: Array<{ key: string; tags: string[]; timestamp: number }> = [];
    let errors = "";
    child.stderr!.on("data", data => { errors += data; });
    child.on("exit", () => { for (const call of pending.values()) call.reject(new Error(errors || "Partition probe exited.")); });
    child.on("message", message => {
      const value = message as Message;
      if (value.type === "partition-result") {
        const call = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) call?.reject(new Error(value.error));
        else call?.resolve(value.result);
      } else if (value.type === "cache-request") {
        void (async () => {
          const adapter = getNextCacheAdapter(), input = value.input;
          let reply;
          if (value.operation === "get") reply = await readNextCacheValue(input as NextCacheGetInput);
          else if (value.operation === "now") reply = Date.now();
          else if (value.operation === "set") {
            const entry = (input as NextCacheSetInput).value as { kind: string; entry: { tags: string[]; timestamp: number } };
            if (entry.kind === "TUTO_USE_CACHE") writes.push({ key: (input as NextCacheSetInput).key, tags: entry.entry.tags, timestamp: entry.entry.timestamp });
            reply = await writeNextCacheValue(input as NextCacheSetInput);
          } else if (value.operation === "acquireLock") reply = await adapter.acquireLock(input as NextCacheLockInput);
          else if (value.operation === "releaseLock") reply = await adapter.releaseLock(input as NextCacheLock);
          else reply = await revalidateNextCacheTags(input as NextCacheRevalidateInput);
          child.send({ type: "cache-response", requestId: value.requestId, ok: true, value: reply });
        })().catch(error => { if (child.connected) child.send({ type: "cache-response", requestId: value.requestId, ok: false, error: error.message }); });
      }
    });
    function read(tenant: string): Promise<ProbeResult> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ type: "partition-probe", id, tenant });
      });
    }
    try {
      const tenantA = clock + "-" + randomUUID(), tenantB = clock + "-" + randomUUID();
      const before = Date.now(), first = await read(tenantA);
      expect(first.value).toEqual({ id: tenantA, value: 1 });
      expect(writes).toHaveLength(2);
      const specific = writes.find(write => write.key.endsWith(JSON.stringify([["tenant", tenantA]])))!;
      const coarse = writes.find(write => write !== specific)!;
      expect(specific).toBeDefined();
      expect(coarse.tags.some(tag => tag.includes("tenant") && tag !== "partition-" + tenantA)).toBe(true);
      for (const write of writes) {
        expect(write.timestamp).toBeGreaterThanOrEqual(before);
        expect(write.timestamp).toBeLessThanOrEqual(Date.now());
      }
      expect(first.metrics.dependencies!.expiresAt).toBe(Math.min(...writes.map(write => write.timestamp)) + 2000);
      const warm = await read(tenantA);
      expect(warm.value).toEqual(first.value);
      expect(warm.metrics.dependencies!.expiresAt).toBeLessThanOrEqual(Math.max(...writes.map(write => write.timestamp)) + 2000);
      expect((await read(tenantB)).value).toEqual({ id: tenantB, value: 1 });
      expect((await read(tenantA)).value).toEqual(first.value);
      await pause(2150);
      const stale = await read(tenantA);
      expect(stale.value).toEqual(first.value);
      expect(stale.metrics.dependencies!.expiresAt).toBe(0);
      expect((await read(tenantA)).value).toEqual({ id: tenantA, value: 2 });
    } finally {
      child.kill();
    }
  });
}

test("a descendant parameter below app/layout is not a root-params export", async () => {
  const files = cacheLifetimeParityWorkspace();
  files.find(file => file.path === "app/api/probe/route.ts")!.content = 'import {tenant} from "next/root-params";export async function GET(){return Response.json({tenant:await tenant()});}';
  await expect(compileNextRequestWorkspace(files, { workspaceKey: "root-params-not-exported", serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" })).rejects.toThrow(/No matching export/);
});
