import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleNextCacheCoordinatorRequest,
  MemoryNextCacheInvalidationCoordinator,
} from "../../lib/serverless-next/durable-cache-adapter";
import {
  handleNextCacheCoordinatorWorkerRequest,
  nextCacheCoordinatorObjectName,
  type NextCacheCoordinatorNamespace,
} from "../../lib/serverless-next/cache-coordinator-worker";
import { runLoadTest } from "../../scripts/load-next-cache-coordinator.mjs";

describe("Next cache coordinator load probe", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("checks concurrent allocation, lease contention, and invalidation fencing", async () => {
    const coordinator = new MemoryNextCacheInvalidationCoordinator();
    const authorization = "Bearer load-test-token";
    vi.stubGlobal("fetch", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      const response = await handleNextCacheCoordinatorRequest(
        request,
        coordinator,
        { authorization },
      );
      const forwarded = new Response(response.body, response);
      forwarded.headers.set(
        "cf-ray",
        `test-${new URL(request.url).hostname === "first.test" ? "SFO" : "FRA"}`,
      );
      return forwarded;
    }) as typeof fetch);

    const result = await runLoadTest({
      allocations: 50,
      concurrency: 16,
      endpoints: ["https://first.test/v1", "https://second.test/v1"],
      minColos: 2,
      token: "load-test-token",
    });

    expect(result.protocolRequests).toBe(71);
    expect(result.colos).toEqual(["FRA", "SFO"]);
    expect(result.tests).toEqual({
      invalidationFencing: "passed",
      leaseContention: "passed",
      monotonicAllocation: "passed",
    });
  });

  test("authenticates and isolates each workspace behind a hashed object name", async () => {
    const objectNames: string[] = [];
    const coordinators = new Map<
      string,
      MemoryNextCacheInvalidationCoordinator
    >();
    const namespace: NextCacheCoordinatorNamespace = {
      getByName(name) {
        objectNames.push(name);
        let coordinator = coordinators.get(name);
        if (!coordinator) {
          coordinator = new MemoryNextCacheInvalidationCoordinator();
          coordinators.set(name, coordinator);
        }
        return {
          fetch: (request) =>
            handleNextCacheCoordinatorRequest(request, coordinator),
        };
      },
    };
    const allocate = (workspaceKey: string, authorization = "Bearer secret") =>
      handleNextCacheCoordinatorWorkerRequest(
        new Request("https://coordinator.test/v1", {
          body: JSON.stringify({
            input: { workspaceKey },
            operation: "allocate",
          }),
          headers: { authorization, "content-type": "application/json" },
          method: "POST",
        }),
        { namespace, token: "secret" },
      );

    expect((await allocate("workspace-a", "Bearer wrong")).status).toBe(401);
    const first = await (await allocate("workspace-a")).json();
    const second = await (await allocate("workspace-a")).json();
    const isolated = await (await allocate("workspace-b")).json();

    expect(first.value.sequence).toBe(1);
    expect(second.value.sequence).toBe(2);
    expect(isolated.value.sequence).toBe(1);
    expect(new Set(objectNames)).toEqual(
      new Set([
        await nextCacheCoordinatorObjectName("workspace-a"),
        await nextCacheCoordinatorObjectName("workspace-b"),
      ]),
    );
    expect(objectNames.join(" ")).not.toContain("workspace-a");
  });
});
