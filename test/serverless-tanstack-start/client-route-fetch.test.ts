import assert from "node:assert/strict";
import { test } from "vitest";
import { createTanstackStartRouteFetch } from "../../lib/serverless-tanstack-start/client-route-fetch";

test("proxies Request objects without losing request metadata or bodies", async () => {
  let observedRequest: Request | undefined;
  const routeFetch = createTanstackStartRouteFetch(
    async (input, init) => {
      observedRequest = new Request(input, init);
      return Response.json({ ok: true });
    },
    {
      href: "https://preview.test/current",
      origin: "https://preview.test",
    },
    "https://preview.test/api/serverless/tanstack-start/core-route?revision=rev&token=cap&path=",
  );
  const abortController = new AbortController();
  const sourceRequest = new Request("https://preview.test/api/orders?draft=1", {
    body: JSON.stringify({ name: "Ada" }),
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      "x-preview-request": "preserved",
    },
    method: "PATCH",
    redirect: "manual",
    signal: abortController.signal,
  });
  const response = await routeFetch(sourceRequest);

  assert.equal(response.status, 200);
  assert.ok(observedRequest);
  assert.equal(observedRequest.method, "PATCH");
  assert.equal(observedRequest.credentials, "include");
  assert.equal(observedRequest.redirect, "manual");
  abortController.abort();
  assert.equal(observedRequest.signal.aborted, true);
  assert.equal(observedRequest.headers.get("x-preview-request"), "preserved");
  assert.deepEqual(await observedRequest.json(), { name: "Ada" });
  const observedUrl = new URL(observedRequest.url);
  assert.equal(
    observedUrl.pathname,
    "/api/serverless/tanstack-start/core-route",
  );
  assert.equal(observedUrl.searchParams.get("path"), "/api/orders?draft=1");
});

test("leaves external and Tuto runtime requests outside the route gateway", async () => {
  const observedInputs: Array<RequestInfo | URL> = [];
  const routeFetch = createTanstackStartRouteFetch(
    async (input) => {
      observedInputs.push(input);
      return new Response(null, { status: 204 });
    },
    {
      href: "https://preview.test/current",
      origin: "https://preview.test",
    },
    "https://preview.test/api/serverless/tanstack-start/core-route?path=",
  );

  const external = new Request("https://example.com/data");
  await routeFetch(external);
  await routeFetch("/api/serverless/tanstack-start/core-asset?kind=client");

  assert.equal(observedInputs[0], external);
  assert.equal(
    observedInputs[1],
    "/api/serverless/tanstack-start/core-asset?kind=client",
  );
});

test("maps static server-function cache URLs to authenticated immutable assets", async () => {
  let observedRequest: Request | undefined;
  const routeFetch = createTanstackStartRouteFetch(
    async (input, init) => {
      observedRequest = new Request(input, init);
      return new Response("cached");
    },
    {
      href: "https://preview.test/current",
      origin: "https://preview.test",
    },
    "https://preview.test/api/serverless/tanstack-start/core-route?path=",
    "https://preview.test/api/serverless/tanstack-start/core-asset?revision=rev&token=cap&kind=static-server-function&name=",
  );
  const cachePath = `/__tsr/staticServerFnCache/${"a".repeat(40)}.json`;

  const response = await routeFetch(cachePath);

  assert.equal(await response.text(), "cached");
  assert.ok(observedRequest);
  const url = new URL(observedRequest.url);
  assert.equal(url.pathname, "/api/serverless/tanstack-start/core-asset");
  assert.equal(url.searchParams.get("kind"), "static-server-function");
  assert.equal(url.searchParams.get("name"), cachePath);
  assert.equal(observedRequest.method, "GET");
  assert.equal(observedRequest.credentials, "include");
});
