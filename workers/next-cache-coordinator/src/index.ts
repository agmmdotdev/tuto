/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  handleNextCacheCoordinatorRequest,
  TransactionalNextCacheInvalidationCoordinator,
  type NextCacheCoordinatorStorage,
} from "../../../lib/serverless-next/durable-cache-adapter";
import { handleNextCacheCoordinatorWorkerRequest } from "../../../lib/serverless-next/cache-coordinator-worker";

type Env = {
  NEXT_CACHE_COORDINATOR: DurableObjectNamespace<NextCacheCoordinator>;
  TUTO_NEXT_CACHE_COORDINATOR_TOKEN: string;
};

/**
 * One instance is selected per workspace by the outer Worker. Durable Object
 * storage supplies the serializable metadata transaction required by the
 * coordinator's sequences, tag mutations, and leases.
 */
export class NextCacheCoordinator extends DurableObject<Env> {
  private readonly coordinator: TransactionalNextCacheInvalidationCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new TransactionalNextCacheInvalidationCoordinator(
      ctx.storage as unknown as NextCacheCoordinatorStorage,
    );
  }

  async fetch(request: Request) {
    return handleNextCacheCoordinatorRequest(request, this.coordinator);
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleNextCacheCoordinatorWorkerRequest(request, {
      namespace: env.NEXT_CACHE_COORDINATOR,
      token: env.TUTO_NEXT_CACHE_COORDINATOR_TOKEN,
    });
  },
} satisfies ExportedHandler<Env>;

export default worker;
