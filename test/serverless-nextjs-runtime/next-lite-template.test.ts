import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getServerlessNextLiteTemplate } from "@/lib/ide/templates";
import {
  buildNextLiteApp,
  loadNextLiteRenderer,
} from "@/lib/serverless-nextjs-runtime/next-lite";

const fixtureRoots: string[] = [];

async function createTemplateFixture() {
  const template = getServerlessNextLiteTemplate();

  if (!template) {
    throw new Error("Next Lite template is missing.");
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tuto-next-lite-template-"));
  fixtureRoots.push(root);

  for (const file of template.files) {
    const absolutePath = path.join(root, file.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.content, "utf8");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("next-lite playground template", () => {
  it("compiles and renders the root route", async () => {
    const root = await createTemplateFixture();
    const artifact = await buildNextLiteApp({
      outDir: path.join(root, ".next-lite"),
      workspaceRoot: root,
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(new Request("http://next-lite.test/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Page and layout are rendered by the lightweight compiler.");
    expect(html).toContain("Dynamic post");
  });

  it("compiles and renders the dynamic post route with params and searchParams", async () => {
    const root = await createTemplateFixture();
    const artifact = await buildNextLiteApp({
      outDir: path.join(root, ".next-lite"),
      workspaceRoot: root,
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/posts/first-post?tab=notes"),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Post: <!-- -->first-post");
    expect(html).toContain("Selected tab: <!-- -->notes");
    expect(html).toContain("Nested posts layout");
    expect(html).toContain("Dynamic post detail layout");
  });

  it("compiles and runs the template route handler", async () => {
    const root = await createTemplateFixture();
    const artifact = await buildNextLiteApp({
      outDir: path.join(root, ".next-lite"),
      workspaceRoot: root,
    });
    const renderer = await loadNextLiteRenderer(artifact);
    const response = await renderer.renderNextLiteRequest(
      new Request("http://next-lite.test/api/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runtime: "next-lite",
      path: "/api/health",
    });
  });
});
