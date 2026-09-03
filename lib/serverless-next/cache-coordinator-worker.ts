type CoordinatorEnvelope = {
  input?: { workspaceKey?: unknown };
  operation?: unknown;
};

export interface NextCacheCoordinatorNamespace {
  getByName(name: string): {
    fetch(request: Request): Promise<Response>;
  };
}

export type NextCacheCoordinatorWorkerOptions = {
  namespace: NextCacheCoordinatorNamespace;
  token: string | undefined;
};

const coordinatorPath = "/v1";
const maxRequestBytes = 64 * 1024;
const operations = new Set([
  "acquire-lease",
  "allocate",
  "get-tag-states",
  "release-lease",
  "revalidate-tags",
]);

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function nextCacheCoordinatorObjectName(workspaceKey: string) {
  const bytes = new TextEncoder().encode(workspaceKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `workspace:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function readEnvelope(
  request: Request,
): Promise<{ body: string; workspaceKey: string } | { response: Response }> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return { response: jsonError("Request body is too large.", 413) };
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxRequestBytes) {
    return { response: jsonError("Request body is too large.", 413) };
  }
  let message: CoordinatorEnvelope;
  try {
    message = JSON.parse(body) as CoordinatorEnvelope;
  } catch {
    return { response: jsonError("Request body must be valid JSON.", 400) };
  }
  const workspaceKey = message?.input?.workspaceKey;
  if (
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    workspaceKey.length > 512
  ) {
    return { response: jsonError("A valid workspaceKey is required.", 400) };
  }
  if (
    typeof message.operation !== "string" ||
    !operations.has(message.operation)
  ) {
    return { response: jsonError("Invalid coordinator operation.", 400) };
  }
  return { body, workspaceKey };
}

export async function handleNextCacheCoordinatorWorkerRequest(
  request: Request,
  options: NextCacheCoordinatorWorkerOptions,
) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      service: "tuto-next-cache-coordinator",
      status: "ok",
    });
  }
  if (url.pathname !== coordinatorPath) return jsonError("Not found.", 404);
  if (request.method !== "POST") {
    return jsonError("Method not allowed.", 405);
  }
  if (!options.token) {
    return jsonError("Coordinator token is not configured.", 503);
  }
  if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
    return jsonError("Unauthorized.", 401);
  }

  const envelope = await readEnvelope(request);
  if ("response" in envelope) return envelope.response;
  const id = await nextCacheCoordinatorObjectName(envelope.workspaceKey);
  const stub = options.namespace.getByName(id);
  return stub.fetch(
    new Request("https://next-cache-coordinator.internal/v1", {
      body: envelope.body,
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
}
