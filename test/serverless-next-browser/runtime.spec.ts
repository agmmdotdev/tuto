import { expect, test } from "@playwright/test";
import type { WorkspaceFile } from "../../lib/ide/types";
import { compileNextRequestWorkspace } from "../../lib/serverless-next/compiler";
import {
  executeNextRequestArtifact,
  executeNextServerActionArtifact,
  renderHydratableNextRequestArtifact,
} from "../../lib/serverless-next/runtime";

const files: WorkspaceFile[] = [
  {
    content: `import "./global.css";
export const metadata = { title: "Next browser checkpoint" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><h1>Next request runtime</h1>{children}</body></html>;
}`,
    language: "tsx",
    path: "app/layout.tsx",
  },
  {
    content: `import Link from "next/link";
import Counter from './counter';
import NavigationControls from "./navigation-controls";
export default function Page() { return <main><p>server-browser-checkpoint</p><Counter /><Link data-next-link href="/lesson?tab=rsc">lesson</Link><NavigationControls /></main>; }`,
    language: "tsx",
    path: "app/page.tsx",
  },
  {
    content: `"use client";
import { useState } from 'react';
import styles from "./counter.module.css";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button className={styles.counter} data-client="counter" onClick={() => setCount((value) => value + 1)}>count:{count}</button>;
}`,
    language: "tsx",
    path: "app/counter.tsx",
  },
  {
    content: `"use client";
import { usePathname, useRouter } from "next/navigation";
export default function NavigationControls() {
  const router = useRouter();
  return <button data-router-replace onClick={() => router.replace("/replaced")}>replace:{usePathname()}</button>;
}`,
    language: "tsx",
    path: "app/navigation-controls.tsx",
  },
  {
    content: "body { background: rgb(240, 241, 242); }",
    language: "css",
    path: "app/global.css",
  },
  {
    content: ".counter { color: rgb(102, 51, 153); }",
    language: "css",
    path: "app/counter.module.css",
  },
];

const actionFiles: WorkspaceFile[] = [
  {
    content: `import { NextResponse, type NextRequest } from "next/server";
export const config = { matcher: ["/"] };
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  if (request.headers.has("next-action")) headers.set("x-action-proxy", "passed");
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set("proxy-action", "continued", { path: "/" });
  return response;
}`,
    language: "ts",
    path: "proxy.ts",
  },
  {
    content: `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
    language: "tsx",
    path: "app/layout.tsx",
  },
  {
    content: `"use server";
import { cookies, headers } from "next/headers";
let total = 0;
export async function increment(delta: number) {
  const requestCookies = await cookies();
  const previous = requestCookies.get("last-action")?.value ?? "none";
  total += delta;
  requestCookies.set("last-action", String(total), { path: "/" });
  return [total, (await headers()).get("x-action-proxy"), requestCookies.get("proxy-action")?.value, previous].join("|");
}
export async function current() { return total; }`,
    language: "ts",
    path: "app/actions.ts",
  },
  {
    content: `import { cookies } from "next/headers";
import { current } from "./actions";
import ActionButton from "./action-button";
import ActionForm from "./action-form";
export default async function Page() {
  const lessonId = "rsc";
  async function save(previous: string, formData: FormData) {
    "use server";
    await new Promise((resolve) => setTimeout(resolve, 80));
    return lessonId + "|" + previous + "|" + formData.get("title");
  }
  return <main><p data-server-total>server-total:{await current()}</p><p data-action-cookie>action-cookie:{(await cookies()).get("last-action")?.value ?? "none"}</p><ActionButton /><ActionForm action={save} /></main>;
}`,
    language: "tsx",
    path: "app/page.tsx",
  },
  {
    content: `"use client";
import { useState } from "react";
import { increment } from "./actions";
export default function ActionButton() {
  const [result, setResult] = useState<string | null>(null);
  return <button data-action="increment" onClick={async () => setResult(await increment(4))}>action-result:{result ?? "idle"}</button>;
}`,
    language: "tsx",
    path: "app/action-button.tsx",
  },
  {
    content: `"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
function Submit() {
  const { pending } = useFormStatus();
  return <button data-form-submit disabled={pending}>{pending ? "Saving" : "Save"}</button>;
}
export default function ActionForm({ action }: {
  action(previous: string, formData: FormData): Promise<string>;
}) {
  const [state, formAction] = useActionState(action, "idle");
  return <form action={formAction}><input data-form-title name="title" /><Submit /><p data-form-state>{state}</p></form>;
}`,
    language: "tsx",
    path: "app/action-form.tsx",
  },
];

test("hydrates a Next SWC client boundary and preserves interaction", async ({
  page,
}) => {
  const artifact = await compileNextRequestWorkspace(files, {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: "browser-checkpoint",
  });
  const document = await (
    await renderHydratableNextRequestArtifact(artifact)
  ).text();
  await page.setContent(document, { waitUntil: "load" });

  await expect(page.locator("text=server-browser-checkpoint")).toBeVisible();
  await expect(page).toHaveTitle("Next browser checkpoint");
  await expect(page.locator('[data-client="counter"]')).toHaveText("count:0");
  await expect(page.locator('[data-client="counter"]')).toHaveCSS(
    "color",
    "rgb(102, 51, 153)",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __TUTO_NEXT_HYDRATED__?: string;
            }
          ).__TUTO_NEXT_HYDRATED__,
      ),
    )
    .toBe(artifact.generation);
  await page.locator('[data-client="counter"]').click();
  await expect(page.locator('[data-client="counter"]')).toHaveText("count:1");

  await page.evaluate(() => {
    const globals = globalThis as typeof globalThis & {
      __TUTO_NAV_MESSAGES__?: unknown[];
    };
    globals.__TUTO_NAV_MESSAGES__ = [];
    window.addEventListener("message", (event) => {
      const payload = event.data as { kind?: string } | undefined;
      if (payload?.kind === "navigate") {
        globals.__TUTO_NAV_MESSAGES__?.push(payload);
      }
    });
  });
  await page.locator("[data-next-link]").click();
  await page.locator("[data-router-replace]").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __TUTO_NAV_MESSAGES__?: Array<{
                navigation?: string;
                path?: string;
              }>;
            }
          ).__TUTO_NAV_MESSAGES__,
      ),
    )
    .toEqual([
      expect.objectContaining({ navigation: "push", path: "/lesson?tab=rsc" }),
      expect.objectContaining({ navigation: "replace", path: "/replaced" }),
    ]);
});

test("dispatches a Server Action and applies its refreshed Flight tree", async ({
  page,
}) => {
  const artifact = await compileNextRequestWorkspace(actionFiles, {
    serverReferenceHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    workspaceKey: "browser-action-checkpoint",
  });
  const actionEndpoint = "http://next-action.local/action";
  await page.route(actionEndpoint, async (route) => {
    const payload = JSON.parse(route.request().postData() ?? "{}") as {
      action: Parameters<typeof executeNextServerActionArtifact>[1] & {
        revision: string;
      };
    };
    expect(payload.action.revision).toBe(artifact.revision);
    const response = await executeNextServerActionArtifact(
      artifact,
      payload.action,
    );
    const headers = new Headers(response.headers);
    const setCookies = headers.getSetCookie();
    headers.delete("set-cookie");
    if (setCookies.length > 0) {
      headers.set(
        "x-tuto-next-virtual-set-cookie",
        Buffer.from(JSON.stringify(setCookies)).toString("base64"),
      );
    }
    await route.fulfill({
      body: Buffer.from(await response.arrayBuffer()),
      headers: Object.fromEntries(headers.entries()),
      status: response.status,
    });
  });
  const document = await (
    await executeNextRequestArtifact(artifact, {
      actionEndpoint,
      hydrate: true,
      url: "/",
    })
  ).text();
  await page.setContent(document, { waitUntil: "load" });

  await expect(page.locator("[data-server-total]")).toHaveText(
    "server-total:0",
  );
  await expect(page.locator('[data-action="increment"]')).toHaveText(
    "action-result:idle",
  );
  await page.locator('[data-action="increment"]').click();
  await expect(page.locator('[data-action="increment"]')).toHaveText(
    "action-result:4|passed|continued|none",
  );
  await expect(page.locator("[data-server-total]")).toHaveText(
    "server-total:4",
  );
  await expect(page.locator("[data-action-cookie]")).toHaveText(
    "action-cookie:4",
  );
  await page.locator('[data-action="increment"]').click();
  await expect(page.locator('[data-action="increment"]')).toHaveText(
    "action-result:8|passed|continued|4",
  );

  await page.locator("[data-form-title]").fill("lesson");
  await page.locator("[data-form-submit]").click();
  await expect(page.locator("[data-form-submit]")).toHaveText("Saving");
  await expect(page.locator("[data-form-state]")).toHaveText("rsc|idle|lesson");
  await expect(page.locator("[data-form-submit]")).toHaveText("Save");
});
