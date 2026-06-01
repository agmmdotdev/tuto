/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function compilePreview(files) {
  const child = spawnSync(
    process.execPath,
    ["lib/serverless-tanstack-start/core-preview-runner.generated.cjs"],
    {
      cwd: process.cwd(),
      input: JSON.stringify({ files }),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const match = child.stdout.match(
    /__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__\n([\s\S]*?)\n__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__/,
  );

  if (!match) {
    throw new Error(child.stderr || child.stdout || "Missing preview result payload.");
  }

  return JSON.parse(match[1]);
}

function extractInlineModule(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error("Missing inline preview module.");
  }

  return match[1];
}

async function runPreviewModule(source) {
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function createPreviewFiles(source) {
  return [
    {
      path: "index.html",
      language: "html",
      content: '<div id="root"></div><script type="module" src="/src/main.ts"></script>',
    },
    {
      path: "src/main.ts",
      language: "ts",
      content: source,
    },
  ];
}

test("preview client RPC encodes FormData payloads before fetch", async () => {
  let requestBody;
  const preview = compilePreview(
    createPreviewFiles(`import { createServerFn } from '@tanstack/react-start';

const submitForm = createServerFn({ method: 'POST' }).handler(async () => null);
const formData = new FormData();
formData.append('title', 'Hello');
formData.append('tag', 'a');
formData.append('tag', 'b');

globalThis.__tutoPreviewPromise = submitForm({ data: formData });
`),
  );

  assert.equal(preview.success, true);
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({ success: true, result: "ok", context: {} });
  };

  try {
    await runPreviewModule(extractInlineModule(preview.html));
    await globalThis.__tutoPreviewPromise;
  } finally {
    delete globalThis.fetch;
    delete globalThis.__tutoPreviewPromise;
  }

  assert.equal(requestBody.payload.data.__tutoType, "FormData");
  assert.deepEqual(requestBody.payload.data.entries, [
    ["title", { kind: "string", value: "Hello" }],
    ["tag", { kind: "string", value: "a" }],
    ["tag", { kind: "string", value: "b" }],
  ]);
});

test("preview client RPC decodes serialized Response results", async () => {
  const preview = compilePreview(
    createPreviewFiles(`import { createServerFn } from '@tanstack/react-start';

const getResponse = createServerFn({ method: 'POST' }).handler(async () => null);

globalThis.__tutoPreviewPromise = getResponse().then(async (response) => {
  globalThis.__tutoPreviewResult = {
    isResponse: response instanceof Response,
    status: response.status,
    text: await response.text(),
    source: response.headers.get('x-source'),
  };
});
`),
  );

  assert.equal(preview.success, true);
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      result: {
        __tutoType: "Response",
        body: "created",
        headers: { "x-source": "server-fn" },
        status: 201,
        statusText: "",
      },
      context: {},
    });

  try {
    await runPreviewModule(extractInlineModule(preview.html));
    await globalThis.__tutoPreviewPromise;
    assert.deepEqual(globalThis.__tutoPreviewResult, {
      isResponse: true,
      status: 201,
      text: "created",
      source: "server-fn",
    });
  } finally {
    delete globalThis.fetch;
    delete globalThis.__tutoPreviewPromise;
    delete globalThis.__tutoPreviewResult;
  }
});

test("preview client RPC throws when the RPC endpoint reports failure", async () => {
  const preview = compilePreview(
    createPreviewFiles(`import { createServerFn } from '@tanstack/react-start';

const fail = createServerFn({ method: 'POST' }).handler(async () => null);

globalThis.__tutoPreviewPromise = fail()
  .then(() => {
    globalThis.__tutoPreviewResult = 'unexpected success';
  })
  .catch((error) => {
    globalThis.__tutoPreviewResult = error.message;
  });
`),
  );

  assert.equal(preview.success, true);
  globalThis.fetch = async () =>
    Response.json(
      {
        success: false,
        error: "server exploded",
      },
      { status: 500 },
    );

  try {
    await runPreviewModule(extractInlineModule(preview.html));
    await globalThis.__tutoPreviewPromise;
    assert.equal(globalThis.__tutoPreviewResult, "server exploded");
  } finally {
    delete globalThis.fetch;
    delete globalThis.__tutoPreviewPromise;
    delete globalThis.__tutoPreviewResult;
  }
});
