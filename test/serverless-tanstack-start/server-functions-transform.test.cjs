/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  transformStartServerFunctions,
} = require("../../lib/serverless-tanstack-start/server-functions-transform.generated.cjs");

function createRoot(name) {
  return path.join(process.cwd(), ".tmp", "server-functions-transform-tests", name);
}

test("leaves plain modules without creating server function manifest entries", async () => {
  const files = new Map([
    [
      "src/routes/index.tsx",
      "export function RouteComponent() { return <main>No server function</main>; }",
    ],
  ]);

  const result = await transformStartServerFunctions(files, {
    root: createRoot("plain"),
  });

  assert.deepEqual(Object.keys(result.serverFnsById), []);
  assert.equal(result.serverSplits.size, 0);
  assert.match(
    result.clientFiles.get("src/routes/index.tsx"),
    /No server function/,
  );
  assert.match(result.resolverModule, /const manifest = \{\n\};/);
});

test("rewrites createServerFn handlers into client RPC stubs and server split exports", async () => {
  const files = new Map([
    [
      "src/routes/index.tsx",
      `import { createServerFn } from '@tanstack/react-start';

export const greet = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  return { message: 'hi ' + data.name };
});

export async function runGreeting() {
  return greet({ data: { name: 'Ada' } });
}
`,
    ],
  ]);

  const result = await transformStartServerFunctions(files, {
    root: createRoot("basic-server-fn"),
  });
  const serverFnIds = Object.keys(result.serverFnsById);
  const clientCode = result.clientFiles.get("src/routes/index.tsx");
  const splitEntries = [...result.serverSplits.entries()];

  assert.equal(serverFnIds.length, 1);
  assert.match(clientCode, /@tanstack\/react-start\/client-rpc/);
  assert.match(clientCode, /createClientRpc\("[a-f0-9]{64}"\)/);
  assert.doesNotMatch(clientCode, /message: 'hi '/);
  assert.equal(splitEntries.length, 1);
  assert.equal(splitEntries[0][0], "src/routes/index.tsx?tss-serverfn-split");
  assert.match(splitEntries[0][1], /@tanstack\/react-start\/server-rpc/);
  assert.match(splitEntries[0][1], /export \{ greet_createServerFn_handler \};/);
  assert.match(result.resolverModule, new RegExp(serverFnIds[0]));
  assert.match(result.resolverModule, /module: "src\/routes\/index\.tsx\?tss-serverfn-split"/);
});
