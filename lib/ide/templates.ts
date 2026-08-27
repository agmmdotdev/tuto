import { WorkspaceFile } from "@/lib/ide/types";

export interface WorkspaceTemplate {
  id: string;
  name: string;
  previewPath: string;
  files: WorkspaceFile[];
}

const templates: WorkspaceTemplate[] = [
  {
    id: "next-tutorial-starter",
    name: "Next Tutorial Starter",
    previewPath: "preview.html",
    files: [
      {
        path: "README.md",
        language: "md",
        description: "A short workspace guide for the learner.",
        content: `# Next Tutorial Starter

This workspace now has two preview modes:

- Mock mode serves files directly from session state.
- Secure Exec mode boots server.js inside an isolate and proxies requests to it.

Try editing these files:

- server.js
- preview.html
- styles.css

That proves the control plane and the runtime path before we attempt a real Next dev server.`,
      },
      {
        path: "server.js",
        language: "js",
        description: "The Secure Exec preview server entry point.",
        content: `const fs = require("node:fs/promises");
const http = require("node:http");

function getContentType(pathname) {
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (pathname.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "text/html; charset=utf-8";
}

async function readWorkspaceFile(pathname) {
  const normalizedPath = pathname === "/" ? "/preview.html" : pathname;
  return fs.readFile(\`/root/workspace\${normalizedPath}\`, "utf8");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  try {
    const body = await readWorkspaceFile(url.pathname);
    response.writeHead(200, {
      "content-type": getContentType(url.pathname),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Workspace asset not found.");
  }
});

module.exports = function startServer({ port, host }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      console.log(\`server:listening:\${host}:\${port}\`);
      resolve(server);
    });
  });
};
`,
      },
      {
        path: "package.json",
        language: "json",
        description: "Runtime package manifest for the template.",
        content: `{
  "name": "next-tutorial-starter",
  "private": true,
  "scripts": {
    "dev": "node server.js"
  }
}
`,
      },
      {
        path: "preview.html",
        language: "html",
        description:
          "The main preview document served by the workspace server.",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workspace Preview</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <section class="frame">
      <div class="hero">
        <span class="eyebrow">Sandbox Preview</span>
        <h1>The workspace server is now real.</h1>
        <p>
          This page is served by server.js from inside the workspace. Edit this
          HTML, the stylesheet, or the server entry point to change what the
          iframe renders through the host preview proxy.
        </p>
      </div>
      <div class="grid">
        <article class="card">
          <strong>Server</strong>
          The Secure Exec path boots server.js from /root/workspace.
        </article>
        <article class="card">
          <strong>Assets</strong>
          preview.html and styles.css are fetched through the sandboxed server.
        </article>
        <article class="card">
          <strong>Next Step</strong>
          Replace this workspace server with a real framework dev server later.
        </article>
      </div>
    </section>
  </body>
</html>
`,
      },
      {
        path: "styles.css",
        language: "css",
        description: "The stylesheet served by the workspace server.",
        content: `:root {
  color-scheme: light;
  --ink: #1e1a16;
  --sand: #efe2cb;
  --cream: #fbf6ef;
  --accent: #c55f2b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Space Grotesk", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(197, 95, 43, 0.22), transparent 28rem),
    linear-gradient(180deg, #fff8ef 0%, #f3e5cf 100%);
  padding: 32px;
}

.frame {
  max-width: 900px;
  margin: 0 auto;
  border-radius: 28px;
  overflow: hidden;
  border: 1px solid rgba(30, 26, 22, 0.1);
  background: rgba(251, 246, 239, 0.92);
  box-shadow: 0 24px 60px rgba(54, 32, 16, 0.14);
}

.hero {
  padding: 56px 40px 24px;
}

.eyebrow {
  display: inline-flex;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(197, 95, 43, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 18px 0 12px;
  font-size: clamp(40px, 7vw, 72px);
  line-height: 0.92;
}

p {
  margin: 0;
  max-width: 42rem;
  font-size: 18px;
  line-height: 1.6;
}

.grid {
  display: grid;
  gap: 16px;
  padding: 0 40px 40px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.card {
  border-radius: 24px;
  padding: 20px;
  background: white;
  border: 1px solid rgba(30, 26, 22, 0.08);
}

.card strong {
  display: block;
  margin-bottom: 10px;
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
`,
      },
    ],
  },
  {
    id: "serverless-react-playground",
    name: "Serverless React Playground",
    previewPath: "index.html",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A stateless playground that compiles from the current browser snapshot.",
        content: `# Serverless React Playground

This workspace is stateless by design.

- No per-session filesystem
- No per-session node_modules
- No long-lived dev server
- No terminal

Preview builds use the repo's installed libraries, an esbuild compiler, and a browser-supplied file snapshot.`,
      },
      {
        path: "index.html",
        language: "html",
        description: "HTML entry document for the stateless preview.",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Serverless React Playground</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
      },
      {
        path: "src/main.tsx",
        language: "tsx",
        description: "Client entry for the stateless React app.",
        content: `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
      },
      {
        path: "src/App.tsx",
        language: "tsx",
        description: "The main React screen for the serverless playground.",
        content: `import { ArrowRight, Layers3, Zap } from "lucide-react";
import { motion } from "motion/react";

const facts = [
  {
    icon: Layers3,
    title: "Stateless",
    body: "Preview is built from the files currently open in your browser, not from a session workspace on disk.",
  },
  {
    icon: Zap,
    title: "Shared deps",
    body: "This route uses the repo's installed React, lucide-react, and motion packages through a stateless esbuild bundle step.",
  },
  {
    icon: ArrowRight,
    title: "Fluid-friendly",
    body: "The tradeoff is no terminal, no HMR, and no long-lived child dev server.",
  },
];

export default function App() {
  return (
    <main className="shell">
      <motion.section
        className="hero"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <span className="badge">Serverless React</span>
        <h1>Stateless preview, real React code.</h1>
        <p>
          Edit these files, rebuild, and the iframe will render a fresh bundle
          generated from your in-browser file snapshot.
        </p>
      </motion.section>

      <section className="facts">
        {facts.map(({ body, icon: Icon, title }, index) => (
          <motion.article
            key={title}
            className="fact-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 * index, duration: 0.3, ease: "easeOut" }}
          >
            <div className="fact-icon">
              <Icon size={18} strokeWidth={2.2} />
            </div>
            <strong>{title}</strong>
            <p>{body}</p>
          </motion.article>
        ))}
      </section>
    </main>
  );
}
`,
      },
      {
        path: "src/styles.css",
        language: "css",
        description: "Styles for the stateless React app.",
        content: `:root {
  color-scheme: light;
  --bg: #f7ecdb;
  --panel: rgba(255, 249, 240, 0.88);
  --ink: #23170e;
  --accent: #b95b28;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(185, 91, 40, 0.2), transparent 24rem),
    linear-gradient(180deg, #fff8ef 0%, #ecd7bc 100%);
}

.shell {
  width: min(980px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}

.hero,
.fact-card {
  border-radius: 28px;
  border: 1px solid rgba(35, 23, 14, 0.08);
  background: var(--panel);
  box-shadow: 0 24px 60px rgba(56, 30, 12, 0.12);
}

.hero {
  padding: 44px 36px 28px;
}

.badge {
  display: inline-flex;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(185, 91, 40, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 16px 0 12px;
  font-size: clamp(42px, 7vw, 70px);
  line-height: 0.96;
}

p {
  margin: 0;
  max-width: 40rem;
  font-size: 18px;
  line-height: 1.6;
}

.facts {
  display: grid;
  gap: 16px;
  margin-top: 18px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.fact-card {
  padding: 22px;
}

.fact-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: rgba(185, 91, 40, 0.12);
  color: var(--accent);
}

.fact-card strong {
  display: block;
  margin: 14px 0 10px;
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.fact-card p {
  font-size: 16px;
}
`,
      },
    ],
  },
  {
    id: "serverless-nextjs-playground",
    name: "Serverless Next.js Playground",
    previewPath: "app/page.tsx",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A stateless App Router-like playground built on the shared esbuild compiler.",
        content: `# Serverless Next.js Playground

This workspace is a stateless, Next-flavored playground.

- No session filesystem
- No long-lived dev server
- No route handlers
- No React Server Components

What it does support:

- \`app/page.tsx\`
- \`app/layout.tsx\`
- \`app/globals.css\`
- lightweight browser shims for \`next/link\`, \`next/image\`, and \`next/navigation\`

So this feels like a small App Router workspace, but it is still compiled into a browser bundle from your saved snapshot.`,
      },
      {
        path: "app/layout.tsx",
        language: "tsx",
        description: "Root layout for the stateless Next-style app.",
        content: `import type { ReactNode } from "react";
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="topbar">
            <span className="brand">TUTO / NEXTJS</span>
            <nav className="topnav">
              <a href="#why">Why it works</a>
              <a href="#cards">Cards</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
`,
      },
      {
        path: "app/page.tsx",
        language: "tsx",
        description:
          "The main App Router page for the stateless Next-style app.",
        content: `import { ArrowRight, Orbit, PanelsTopLeft } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";

const cards = [
  {
    icon: PanelsTopLeft,
    title: "App Router shape",
    body: "This route lets you work inside app/page.tsx and app/layout.tsx instead of a plain src/main.tsx entry.",
  },
  {
    icon: Orbit,
    title: "Stateless compile",
    body: "The preview still comes from a fresh esbuild bundle generated from your last saved snapshot.",
  },
  {
    icon: ArrowRight,
    title: "Subset of Next",
    body: "It supports a small browser-friendly slice of Next APIs, not the full framework runtime.",
  },
];

const heroArt = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 420 280'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' x2='1' y1='0' y2='1'%3E%3Cstop stop-color='%23d0682f'/%3E%3Cstop offset='1' stop-color='%23261a12'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='420' height='280' rx='28' fill='%23f7ecdb'/%3E%3Cpath d='M42 201c40-74 110-120 197-120 65 0 113 26 139 58' fill='none' stroke='url(%23g)' stroke-width='24' stroke-linecap='round'/%3E%3Ccircle cx='114' cy='108' r='28' fill='%23d0682f' fill-opacity='.16'/%3E%3Ccircle cx='297' cy='168' r='44' fill='%23261a12' fill-opacity='.08'/%3E%3C/svg%3E";

export default function Page() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="badge">Serverless Next.js</span>
          <h1>App Router feel, stateless compiler underneath.</h1>
          <p>
            Edit <code>app/page.tsx</code>, <code>app/layout.tsx</code>, and{" "}
            <code>app/globals.css</code>. Save, and the serverless preview will
            rebuild from the current snapshot.
          </p>
          <div className="hero-actions">
            <Link className="cta" href="#cards">
              Explore the cards
            </Link>
            <Link className="secondary" href="#why">
              Read the tradeoffs
            </Link>
          </div>
        </div>

        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="hero-art"
          initial={{ opacity: 0, y: 18 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <Image
            alt="Abstract orange arc artwork"
            className="hero-image"
            height={280}
            src={heroArt}
            width={420}
          />
        </motion.div>
      </section>

      <section className="card-grid" id="cards">
        {cards.map(({ body, icon: Icon, title }, index) => (
          <motion.article
            animate={{ opacity: 1, y: 0 }}
            className="card"
            initial={{ opacity: 0, y: 20 }}
            key={title}
            transition={{ delay: index * 0.06, duration: 0.28, ease: "easeOut" }}
          >
            <span className="card-icon">
              <Icon size={18} strokeWidth={2.2} />
            </span>
            <strong>{title}</strong>
            <p>{body}</p>
          </motion.article>
        ))}
      </section>

      <section className="why" id="why">
        <p>
          This is not a real Next.js dev server. It is a browser-previewable App
          Router subset rendered from a stateless compile step. That makes it
          much easier to deploy than a per-user long-lived runtime.
        </p>
      </section>
    </main>
  );
}
`,
      },
      {
        path: "app/globals.css",
        language: "css",
        description: "Global styles for the stateless Next-style app.",
        content: `:root {
  color-scheme: light;
  --bg: #f4ead8;
  --panel: rgba(255, 249, 240, 0.88);
  --panel-strong: rgba(36, 25, 17, 0.95);
  --ink: #261a12;
  --accent: #d0682f;
  --muted: #705a48;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(208, 104, 47, 0.18), transparent 24rem),
    linear-gradient(180deg, #fff8ef 0%, #e9d5bb 100%);
}

a {
  color: inherit;
  text-decoration: none;
}

code {
  padding: 0.08rem 0.35rem;
  border-radius: 0.45rem;
  background: rgba(38, 26, 18, 0.08);
  font-family: Consolas, monospace;
  font-size: 0.92em;
}

.site-shell {
  width: min(1100px, calc(100% - 32px));
  margin: 0 auto;
  padding: 24px 0 56px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 0 22px;
}

.brand {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--accent);
  text-transform: uppercase;
}

.topnav {
  display: flex;
  gap: 16px;
  color: var(--muted);
  font-size: 14px;
}

.page-shell {
  display: grid;
  gap: 18px;
}

.hero,
.card,
.why {
  border-radius: 28px;
  border: 1px solid rgba(38, 26, 18, 0.08);
  background: var(--panel);
  box-shadow: 0 24px 60px rgba(56, 30, 12, 0.12);
}

.hero {
  display: grid;
  gap: 28px;
  align-items: center;
  padding: 34px;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
}

.badge {
  display: inline-flex;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(208, 104, 47, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 16px 0 12px;
  font-size: clamp(40px, 7vw, 72px);
  line-height: 0.94;
}

p {
  margin: 0;
  line-height: 1.65;
}

.hero-copy p {
  max-width: 38rem;
  font-size: 18px;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 22px;
}

.cta,
.secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  font-weight: 600;
}

.cta {
  background: var(--panel-strong);
  color: white;
}

.secondary {
  border: 1px solid rgba(38, 26, 18, 0.12);
}

.hero-art {
  position: relative;
}

.hero-image {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 24px;
  border: 1px solid rgba(38, 26, 18, 0.08);
}

.card-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.card {
  padding: 22px;
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: rgba(208, 104, 47, 0.12);
  color: var(--accent);
}

.card strong {
  display: block;
  margin: 14px 0 10px;
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.why {
  padding: 24px 26px;
  color: var(--muted);
}

@media (max-width: 840px) {
  .hero {
    grid-template-columns: 1fr;
  }

  .topbar {
    flex-direction: column;
    align-items: flex-start;
  }
}
`,
      },
    ],
  },
  {
    id: "serverless-tanstack-start-playground",
    name: "Serverless TanStack Start Playground",
    previewPath: "src/routes/index.tsx",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A TanStack Start-style playground that stays stateless and Vercel-safe.",
        content: `# Serverless TanStack Start Playground

This route is the lightweight TanStack Start compiler-core experiment.

What is real here:

- real \`@tanstack/start-plugin-core\` transforms
- real \`@tanstack/react-router\`
- an esbuild browser preview bundle
- real route modules under \`src/routes\`
- real nested layouts, loaders, params, search state, links, and native Start RPC serialization
- real \`@tanstack/start-client-core\` and \`@tanstack/start-server-core\` execution
- real \`src/start.ts\` request middleware, function middleware, request/response helpers, cookies, and sessions for server-function requests
- real router SSR, loader execution, hydration, and compiled CSS through the official Start handler

What is intentionally still experimental here:

- no long-lived Vite dev server
- no Vite build inside the serverless function
- saved snapshots compile to content-addressed artifacts with a bounded hot cache and optional signed durable storage
- browser-side server function calls send only the native Start request plus revision and function id
- server bundles execute in bounded, revision-pinned child workers, not in the Next.js host process

This is the first SSR tier, not the complete production host: worker responses
are buffered and the route manifest is still revision-wide. Without durable
storage, a missing hot artifact asks you to rebuild; configured durable storage
restores it across app processes.`,
      },
      {
        path: "index.html",
        language: "html",
        description: "HTML entry document for the TanStack playground.",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Serverless TanStack Start Playground</title>
  </head>
  <body class="m-0">
    <div id="app"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
      },
      {
        path: "src/main.tsx",
        language: "tsx",
        description: "Client entry for the TanStack router app.",
        content: `import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

function patchSrcDocHistory() {
  if (
    typeof window === "undefined" ||
    typeof location === "undefined" ||
    location.href !== "about:srcdoc"
  ) {
    return;
  }

  const safeWrap = <T extends typeof window.history.pushState | typeof window.history.replaceState>(
    method: T,
  ) => {
    return ((...args: Parameters<T>) => {
      try {
        return method.apply(window.history, args);
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "SecurityError"
        ) {
          return undefined;
        }

        throw error;
      }
    }) as T;
  };

  window.history.pushState = safeWrap(window.history.pushState);
  window.history.replaceState = safeWrap(window.history.replaceState);
}

patchSrcDocHistory();

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error('Missing root element "#app".');
}

async function bootstrap() {
  const [{ RouterProvider }, { router }] = await Promise.all([
    import("@tanstack/react-router"),
    import("./router"),
  ]);

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}

void bootstrap();
`,
      },
      {
        path: "src/start.ts",
        language: "ts",
        description:
          "Official TanStack Start request-host configuration for server-function requests.",
        content: `import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === "serverFn",
});

const previewRequestMiddleware = createMiddleware().server(
  async ({ handlerType, next, request }) => {
    setResponseHeader("x-tuto-start-middleware", "active");

    return next({
      context: {
        previewRequest: {
          handlerType,
          method: request.method,
        },
      },
    });
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, previewRequestMiddleware],
}));
`,
      },
      {
        path: "src/router.tsx",
        language: "tsx",
        description: "Router setup for the stateless TanStack playground.",
        content: `import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree,
    defaultPreload: "intent",
    defaultPendingMinMs: 180,
    defaultPendingMs: 120,
    scrollRestoration: false,
  });
}

export const router = getRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
`,
      },
      {
        path: "src/routeTree.gen.ts",
        language: "ts",
        description:
          "A fixed generated route tree for the stateless file-route playground.",
        content: `/* eslint-disable */

// @ts-nocheck

// This file mirrors the generated TanStack route tree shape used by file-based routing.

import { Route as rootRouteImport } from "./routes/__root";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as PostsRouteImport } from "./routes/posts";
import { Route as PostsIndexRouteImport } from "./routes/posts.index";
import { Route as PostsPostIdRouteImport } from "./routes/posts.$postId";

const IndexRoute = IndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => rootRouteImport,
} as any);

const PostsRoute = PostsRouteImport.update({
  id: "/posts",
  path: "/posts",
  getParentRoute: () => rootRouteImport,
} as any);

const PostsIndexRoute = PostsIndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => PostsRoute,
} as any);

const PostsPostIdRoute = PostsPostIdRouteImport.update({
  id: "/$postId",
  path: "/$postId",
  getParentRoute: () => PostsRoute,
} as any);

export interface FileRoutesByFullPath {
  "/": typeof IndexRoute;
  "/posts": typeof PostsRouteWithChildren;
  "/posts/$postId": typeof PostsPostIdRoute;
  "/posts/": typeof PostsIndexRoute;
}

export interface FileRoutesByTo {
  "/": typeof IndexRoute;
  "/posts": typeof PostsIndexRoute;
  "/posts/$postId": typeof PostsPostIdRoute;
}

export interface FileRoutesById {
  __root__: typeof rootRouteImport;
  "/": typeof IndexRoute;
  "/posts": typeof PostsRouteWithChildren;
  "/posts/$postId": typeof PostsPostIdRoute;
  "/posts/": typeof PostsIndexRoute;
}

export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath;
  fullPaths: "/" | "/posts" | "/posts/$postId" | "/posts/";
  fileRoutesByTo: FileRoutesByTo;
  to: "/" | "/posts" | "/posts/$postId";
  id: "__root__" | "/" | "/posts" | "/posts/$postId" | "/posts/";
  fileRoutesById: FileRoutesById;
}

interface RootRouteChildren {
  IndexRoute: typeof IndexRoute;
  PostsRoute: typeof PostsRouteWithChildren;
}

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/": {
      id: "/";
      path: "/";
      fullPath: "/";
      preLoaderRoute: typeof IndexRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/posts": {
      id: "/posts";
      path: "/posts";
      fullPath: "/posts";
      preLoaderRoute: typeof PostsRouteImport;
      parentRoute: typeof rootRouteImport;
    };
    "/posts/": {
      id: "/posts/";
      path: "/";
      fullPath: "/posts/";
      preLoaderRoute: typeof PostsIndexRouteImport;
      parentRoute: typeof PostsRoute;
    };
    "/posts/$postId": {
      id: "/posts/$postId";
      path: "/$postId";
      fullPath: "/posts/$postId";
      preLoaderRoute: typeof PostsPostIdRouteImport;
      parentRoute: typeof PostsRoute;
    };
  }
}

interface PostsRouteChildren {
  PostsIndexRoute: typeof PostsIndexRoute;
  PostsPostIdRoute: typeof PostsPostIdRoute;
}

const PostsRouteChildren: PostsRouteChildren = {
  PostsIndexRoute,
  PostsPostIdRoute,
};

const PostsRouteWithChildren = PostsRoute._addFileChildren(PostsRouteChildren);

const rootRouteChildren: RootRouteChildren = {
  IndexRoute,
  PostsRoute: PostsRouteWithChildren,
};

export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>();
`,
      },
      {
        path: "src/lib/posts.ts",
        language: "ts",
        description: "Shared mock data and loader helpers for the route files.",
        content: `export type DemoPost = {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  notes: string[];
  metrics: Array<{ label: string; value: string }>;
};

export const posts: DemoPost[] = [
  {
    id: "launch-checklist",
    eyebrow: "Shipping",
    title: "Launch checklist",
    summary:
      "A route loader can still shape local data, preload on intent, and hydrate a nested detail panel without inventing framework shims.",
    notes: [
      "Keep the route tree explicit so links and params stay strongly typed.",
      "Treat loaders as browser-safe data hooks in this stateless mode.",
      "Save SSR and server functions for a trusted runtime, not public Vercel Functions.",
    ],
    metrics: [
      { label: "Runtime", value: "Browser loader" },
      { label: "Isolation", value: "No temp workspace" },
      { label: "Preview", value: "Stateless bundle" },
    ],
  },
  {
    id: "edge-cache-playbook",
    eyebrow: "Performance",
    title: "Edge cache playbook",
    summary:
      "Search state, dynamic params, and nested layouts all work with the real router package, which gets you much closer to Start than a fake component shim.",
    notes: [
      "Use search state for small UI modes like notes versus summary.",
      "Use nested layouts to preserve shell state between detail transitions.",
      "Preload detail routes on hover with intent-based defaults.",
    ],
    metrics: [
      { label: "Router", value: "@tanstack/react-router" },
      { label: "Preload", value: "intent" },
      { label: "State", value: "search + params" },
    ],
  },
  {
    id: "preview-boundaries",
    eyebrow: "Platform",
    title: "Preview boundaries",
    summary:
      "The compromise is deliberate: this route favors real client routing over pretending server code is safe to execute inside shared production Functions.",
    notes: [
      "Server functions run from a bounded compiled artifact in a revision-pinned child worker, outside the Next.js host process.",
      "The route files are still real modules you can edit like a Start project.",
      "A future trusted verifier can reuse the same source shape for SSR checks.",
    ],
    metrics: [
      { label: "Host", value: "Vercel-native" },
      { label: "Server code", value: "Isolated child" },
      { label: "Authoring", value: "Start-like" },
    ],
  },
];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadPosts() {
  await wait(140);
  return posts;
}

export async function loadPostById(postId: string) {
  await wait(160);
  return posts.find((post) => post.id === postId) ?? null;
}
`,
      },
      {
        path: "src/routes/__root.tsx",
        language: "tsx",
        description: "The TanStack root route shell and not-found state.",
        content: `import "../styles.css";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundView,
});

const pillLinkClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-stone-900/10 bg-white/55 px-4 text-sm font-medium text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20 data-[active=true]:border-stone-950 data-[active=true]:bg-stone-950 data-[active=true]:text-white";
const panelClass =
  "rounded-[28px] border border-stone-900/10 bg-white/70 shadow-[0_24px_60px_rgba(71,42,20,0.12)] backdrop-blur";

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(201,108,54,0.22),transparent_24rem),radial-gradient(circle_at_85%_20%,rgba(118,90,68,0.16),transparent_20rem),linear-gradient(180deg,#fffaf3_0%,#efe2d1_100%)] font-sans text-stone-950">
          <div className="relative mx-auto w-[min(1120px,calc(100%-32px))] pt-6 pb-14">
        <div className="pointer-events-none fixed top-16 right-[min(12vw,140px)] h-56 w-56 rounded-full bg-orange-400/25 blur-2xl" />
        <div className="pointer-events-none fixed bottom-14 left-[min(8vw,90px)] h-44 w-44 rounded-full bg-stone-700/15 blur-2xl" />

        <header
          className={[panelClass, "relative z-10 grid gap-4 p-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"].join(
            " ",
          )}
        >
          <div className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
              TanStack Start / native SSR
            </span>
            <h1 className="max-w-4xl text-4xl font-semibold leading-[0.92] tracking-[-0.04em] text-stone-950 sm:text-6xl">
              Real route files running in a stateless Vercel preview.
            </h1>
            <p className="max-w-3xl text-[17px] leading-7 text-stone-600 sm:text-lg">
              This playground keeps the framework surface real where it is safe:
              links, nested routes, loaders, search state, params, a generated
              route tree, and now compiled Tailwind utilities.
            </p>
          </div>
          <div className="rounded-full border border-stone-900/10 bg-white/65 px-4 py-2 font-mono text-[12px] font-semibold leading-none text-stone-600 md:justify-self-end">
            {pathname}
          </div>
        </header>

        <nav className="relative z-10 mt-4 flex flex-wrap gap-2.5">
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ "data-active": "true" }}
            className={pillLinkClass}
            to="/"
          >
            Home
          </Link>
          <Link
            activeProps={{ "data-active": "true" }}
            className={pillLinkClass}
            to="/posts"
          >
            Posts
          </Link>
          <Link
            activeProps={{ "data-active": "true" }}
            className={pillLinkClass}
            to="/server-functions"
          >
            Server Functions
          </Link>
          <Link
            activeProps={{ "data-active": "true" }}
            className={pillLinkClass}
            params={{ postId: "launch-checklist" }}
            search={{ tab: "notes" }}
            to="/posts/$postId"
          >
            Dynamic Detail
          </Link>
        </nav>

        <main className="relative z-10 mt-5">
          <Outlet />
        </main>
          </div>
        </div>
        <Scripts />
      </body>
    </html>
  );
}

function NotFoundView() {
  return (
    <section className={[panelClass, "space-y-4 p-8"].join(" ")}>
      <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
        Not found
      </span>
      <h2 className="max-w-3xl text-4xl font-semibold leading-[0.96] tracking-[-0.04em] text-stone-950">
        This route is outside the fixed stateless tree.
      </h2>
      <p className="max-w-3xl text-[17px] leading-7 text-stone-600">
        The route graph here is deliberately explicit, so the preview can stay
        file-based without a temp workspace or background generator process.
      </p>
      <div className="flex flex-wrap gap-3 pt-2">
        <Link
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-stone-950 px-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-stone-800"
          to="/"
        >
          Back home
        </Link>
      </div>
    </section>
  );
}
`,
      },
      {
        path: "src/routes/index.tsx",
        language: "tsx",
        description: "The home route for the stateless TanStack playground.",
        content: `import { Link, createFileRoute } from "@tanstack/react-router";

const highlights = [
  {
    title: "Real Router",
    body: "This route uses the actual @tanstack/react-router package from the repo root, not a fake compatibility layer.",
  },
  {
    title: "Generated shape",
    body: "The route modules mirror a file-based Start setup, and src/routeTree.gen.ts keeps the familiar generated contract.",
  },
  {
    title: "Revision RPC",
    body: "A save creates one content-addressed client/server artifact. Calls use Start's native wire protocol and never resend the workspace.",
  },
];

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

const panelClass =
  "rounded-[28px] border border-stone-900/10 bg-white/70 shadow-[0_24px_60px_rgba(71,42,20,0.12)] backdrop-blur";
const inlineCodeClass =
  "rounded-lg bg-stone-950/8 px-1.5 py-0.5 font-mono text-[0.92em]";

function HomeRoute() {
  return (
    <div className="grid gap-4">
      <section className={[panelClass, "space-y-6 p-8"].join(" ")}>
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
            Closer to Start
          </span>
          <h2 className="max-w-4xl text-4xl font-semibold leading-[0.96] tracking-[-0.04em] text-stone-950 sm:text-5xl">
            Real file routes, loaders, params, search state, and compiled
            Tailwind classes.
          </h2>
          <p className="max-w-3xl text-[17px] leading-7 text-stone-600">
            Edit the route modules in{" "}
            <code className={inlineCodeClass}>src/routes</code>, the shared data
            in <code className={inlineCodeClass}>src/lib/posts.ts</code>, the
            generated tree in{" "}
            <code className={inlineCodeClass}>src/routeTree.gen.ts</code>, or
            the Tailwind entry point in{" "}
            <code className={inlineCodeClass}>src/styles.css</code>. Save, and
            the stateless preview rebuilds from the latest snapshot.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-stone-950 px-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-stone-800"
            to="/posts"
          >
            Browse the nested route
          </Link>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-stone-900/10 bg-white/55 px-4 text-sm font-medium text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20"
            params={{ postId: "edge-cache-playbook" }}
            search={{ tab: "notes" }}
            to="/posts/$postId"
          >
            Jump to a detail route
          </Link>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-stone-900/10 bg-white/55 px-4 text-sm font-medium text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20"
            to="/server-functions"
          >
            Open server functions lab
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {highlights.map((item) => (
          <article className={[panelClass, "space-y-3 p-6"].join(" ")} key={item.title}>
            <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/75">
              {item.title}
            </span>
            <p className="text-[16px] leading-7 text-stone-600">{item.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
`,
      },
      {
        path: "src/routes/posts.tsx",
        language: "tsx",
        description:
          "A nested layout route that loads post data and renders child routes.",
        content: `import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { loadPosts } from "../lib/posts";

export const Route = createFileRoute("/posts")({
  loader: () => loadPosts(),
  component: PostsLayout,
});

const panelClass =
  "rounded-[28px] border border-stone-900/10 bg-white/70 shadow-[0_24px_60px_rgba(71,42,20,0.12)] backdrop-blur";
const postLinkClass =
  "block rounded-[24px] border border-stone-900/10 bg-white/65 p-4 text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20 data-[active=true]:border-stone-950 data-[active=true]:bg-stone-950 data-[active=true]:text-white";

function PostsLayout() {
  const posts = Route.useLoaderData();

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className={[panelClass, "space-y-5 p-6"].join(" ")}>
        <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/75">
          Loader data
        </span>
        <h2 className="text-4xl font-semibold leading-[0.96] tracking-[-0.04em] text-stone-950">
          Posts
        </h2>
        <p className="text-[16px] leading-7 text-stone-600">
          This parent route loads a small dataset, then keeps the shell mounted
          while child routes swap in the detail panel.
        </p>

        <div className="flex flex-col gap-3">
          {posts.map((post) => (
            <Link
              activeProps={{ "data-active": "true" }}
              className={postLinkClass}
              key={post.id}
              params={{ postId: post.id }}
              preload="intent"
              search={{ tab: "summary" }}
              to="/posts/$postId"
            >
              <strong className="block text-base font-semibold">{post.title}</strong>
              <span className="mt-2 block text-[11px] font-bold uppercase tracking-[0.22em] opacity-70">
                {post.eyebrow}
              </span>
            </Link>
          ))}
        </div>
      </aside>

      <section className={[panelClass, "p-6 md:p-7"].join(" ")}>
        <Outlet />
      </section>
    </div>
  );
}
`,
      },
      {
        path: "src/routes/posts.index.tsx",
        language: "tsx",
        description: "Default child route shown before a post is selected.",
        content: `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/posts/")({
  component: PostsIndexRoute,
});

const inlineCodeClass =
  "rounded-lg bg-stone-950/8 px-1.5 py-0.5 font-mono text-[0.92em]";

function PostsIndexRoute() {
  return (
    <div className="space-y-4">
      <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
        Nested index route
      </span>
      <h3 className="max-w-2xl text-4xl font-semibold leading-[0.96] tracking-[-0.04em] text-stone-950">
        Select a post from the left column.
      </h3>
      <p className="max-w-3xl text-[16px] leading-7 text-stone-600">
        This detail panel is the child outlet of{" "}
        <code className={inlineCodeClass}>/posts</code>. Choose a post to see
        params, search state, and route-level loader data working together.
      </p>
    </div>
  );
}
`,
      },
      {
        path: "src/routes/posts.$postId.tsx",
        language: "tsx",
        description: "Dynamic route showing params and search-state tabs.",
        content: `import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { loadPostById } from "../lib/posts";

type PostTab = "summary" | "notes";

export const Route = createFileRoute("/posts/$postId")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === "notes" ? ("notes" as PostTab) : ("summary" as PostTab),
  }),
  loader: async ({ params }) => {
    const post = await loadPostById(params.postId);

    if (!post) {
      throw notFound();
    }

    return post;
  },
  component: PostDetailRoute,
});

const tabClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-stone-900/10 bg-white/55 px-4 text-sm font-medium text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20 data-[active=true]:border-stone-950 data-[active=true]:bg-stone-950 data-[active=true]:text-white";
const metricCardClass =
  "rounded-[24px] border border-stone-900/10 bg-stone-950/[0.03] p-5";

function PostDetailRoute() {
  const post = Route.useLoaderData();
  const { tab } = Route.useSearch();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
          {post.eyebrow}
        </span>
        <span className="rounded-full border border-stone-900/10 bg-white/65 px-4 py-2 font-mono text-[12px] font-semibold leading-none text-stone-600">
          {post.id}
        </span>
      </div>

      <div className="space-y-4">
        <h3 className="max-w-3xl text-4xl font-semibold leading-[0.94] tracking-[-0.04em] text-stone-950 sm:text-[2.75rem]">
          {post.title}
        </h3>
        <p className="max-w-3xl text-[17px] leading-7 text-stone-600">
          {post.summary}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          activeProps={{ "data-active": "true" }}
          className={tabClass}
          params={{ postId: post.id }}
          search={{ tab: "summary" }}
          to="/posts/$postId"
        >
          Summary
        </Link>
        <Link
          activeProps={{ "data-active": "true" }}
          className={tabClass}
          params={{ postId: post.id }}
          search={{ tab: "notes" }}
          to="/posts/$postId"
        >
          Notes
        </Link>
      </div>

      {tab === "notes" ? (
        <ul className="grid gap-3 pl-5 text-[16px] leading-7 text-stone-700 marker:text-orange-700">
          {post.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {post.metrics.map((metric) => (
            <article className={metricCardClass} key={metric.label}>
              <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/75">
                {metric.label}
              </span>
              <strong className="mt-3 block text-lg font-semibold text-stone-950">
                {metric.value}
              </strong>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
`,
      },
      {
        path: "src/routes/server-functions.tsx",
        language: "tsx",
        description:
          "Manual lab for native Start server-function compilation and transport.",
        content: `import { useState, type FormEvent } from "react";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

type LabResult = {
  body: string;
  tone: "idle" | "success" | "error";
  title: string;
};

const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  return next({
    context: {
      userId: "user-1",
      role: "editor",
    },
  });
});

const denyMiddleware = createMiddleware({ type: "function" }).server(async () => {
  return new Response("Blocked by middleware", {
    status: 401,
    headers: { "x-auth": "required" },
  });
});

const greet = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data: unknown) => {
    const name =
      typeof data === "object" && data !== null && "name" in data
        ? String((data as { name?: unknown }).name ?? "").trim()
        : "";

    if (!name) {
      throw new Error("Enter a name first.");
    }

    return { name };
  })
  .handler(async ({ context, data }) => {
    return {
      message: "Hello " + data.name + ".",
      userId: context.userId,
      role: context.role,
    };
  });

const readForm = createServerFn({ method: "POST" }).handler(async ({ data }) => {
  return {
    title: data.get("title"),
    tags: data.getAll("tag"),
  };
});

const responseFunction = createServerFn({ method: "POST" }).handler(async () => {
  return new Response("Created from a server function", {
    status: 201,
    headers: { "x-source": "server-function" },
  });
});

const guardedFunction = createServerFn({ method: "POST" })
  .middleware([denyMiddleware])
  .handler(async () => {
    return "This should not run.";
  });

const redirectFunction = createServerFn({ method: "POST" }).handler(async () => {
  throw redirect({
    href: "/login",
    statusCode: 302,
    headers: { "x-reason": "manual-lab" },
  });
});

const missingFunction = createServerFn({ method: "POST" }).handler(async () => {
  throw notFound({ data: { source: "server-functions-lab" } });
});

export const Route = createFileRoute("/server-functions")({
  component: ServerFunctionsRoute,
});

const panelClass =
  "rounded-[28px] border border-stone-900/10 bg-white/70 shadow-[0_24px_60px_rgba(71,42,20,0.12)] backdrop-blur";
const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-stone-950 px-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50";
const quietButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-stone-900/10 bg-white/55 px-4 text-sm font-medium text-stone-900 transition hover:-translate-y-0.5 hover:border-stone-900/20 disabled:cursor-not-allowed disabled:opacity-50";

function formatValue(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function ServerFunctionsRoute() {
  const [name, setName] = useState("Ada");
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<LabResult>({
    body: "Run an action to inspect the RPC result.",
    tone: "idle",
    title: "Idle",
  });

  async function run(label: string, action: () => Promise<unknown>) {
    setPending(label);

    try {
      const value = await action();
      setResult({
        body: typeof value === "string" ? value : formatValue(value),
        tone: "success",
        title: label,
      });
    } catch (error) {
      setResult({
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
        title: label,
      });
    } finally {
      setPending(null);
    }
  }

  function handleGreet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("Validated POST + middleware context", () =>
      greet({ data: { name } }),
    );
  }

  function handleFormData() {
    const formData = new FormData();
    formData.append("title", "Compiler core");
    formData.append("tag", "form-data");
    formData.append("tag", "rpc");

    void run("FormData payload", () => readForm({ data: formData }));
  }

  function handleResponse() {
    void run("Response result", async () => {
      const response = await responseFunction();

      return {
        isResponse: response instanceof Response,
        source: response.headers.get("x-source"),
        status: response.status,
        text: await response.text(),
      };
    });
  }

  function handleGuarded() {
    void run("Middleware Response", async () => {
      const response = await guardedFunction();

      if (!(response instanceof Response)) {
        return {
          unexpected: response,
        };
      }

      return {
        isResponse: true,
        status: response.status,
        text: await response.text(),
        auth: response.headers.get("x-auth"),
      };
    });
  }

  const statusClass =
    result.tone === "error"
      ? "border-red-900/20 bg-red-50 text-red-950"
      : result.tone === "success"
        ? "border-emerald-900/20 bg-emerald-50 text-emerald-950"
        : "border-stone-900/10 bg-stone-950/[0.03] text-stone-700";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className={[panelClass, "space-y-6 p-8"].join(" ")}>
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full bg-orange-500/12 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/80">
            Server functions
          </span>
          <h2 className="max-w-4xl text-4xl font-semibold leading-[0.96] tracking-[-0.04em] text-stone-950 sm:text-5xl">
            Native Start RPC against one compiled revision.
          </h2>
          <p className="max-w-3xl text-[17px] leading-7 text-stone-600">
            These calls use Start's client runtime and wire format. The endpoint
            resolves the saved revision to a cached server bundle and executes
            it in a warm revision-pinned child worker—no workspace files travel
            on calls.
          </p>
        </div>

        <form className="flex flex-wrap gap-3" onSubmit={handleGreet}>
          <input
            className="min-h-11 min-w-[220px] rounded-full border border-stone-900/10 bg-white/70 px-4 text-sm font-medium text-stone-950 outline-none transition focus:border-stone-950"
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            value={name}
          />
          <button className={buttonClass} disabled={pending !== null} type="submit">
            Run validated POST
          </button>
        </form>

        <div className="grid gap-3 sm:grid-cols-2">
          <button className={quietButtonClass} disabled={pending !== null} onClick={handleFormData} type="button">
            Send FormData
          </button>
          <button className={quietButtonClass} disabled={pending !== null} onClick={handleResponse} type="button">
            Return Response
          </button>
          <button className={quietButtonClass} disabled={pending !== null} onClick={handleGuarded} type="button">
            Middleware Response
          </button>
          <button
            className={quietButtonClass}
            disabled={pending !== null}
            onClick={() => void run("Redirect control", () => redirectFunction())}
            type="button"
          >
            Throw redirect
          </button>
          <button
            className={quietButtonClass}
            disabled={pending !== null}
            onClick={() => void run("Not found control", () => missingFunction())}
            type="button"
          >
            Throw notFound
          </button>
        </div>
      </section>

      <aside className={[panelClass, "flex min-h-[320px] flex-col p-6"].join(" ")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-900/75">
              Result
            </span>
            <h3 className="mt-2 text-2xl font-semibold leading-tight text-stone-950">
              {pending ?? result.title}
            </h3>
          </div>
          <span className={["rounded-full border px-3 py-1 text-xs font-semibold", statusClass].join(" ")}>
            {pending ? "running" : result.tone}
          </span>
        </div>

        <pre className={["mt-5 min-h-0 flex-1 overflow-auto rounded-[18px] border p-4 font-mono text-xs leading-5", statusClass].join(" ")}>
          {pending ? "Waiting for RPC response..." : result.body}
        </pre>
      </aside>
    </div>
  );
}
`,
      },
      {
        path: "src/styles.css",
        language: "css",
        description: "Styles for the stateless TanStack playground.",
        content: `@import "tailwindcss";

@theme {
  --font-sans: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
  --font-mono: Consolas, monospace;
}
`,
      },
    ],
  },
  {
    id: "serverless-next-lite-playground",
    name: "Serverless Next Lite Playground",
    previewPath: "app/page.tsx",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A minimal App Router subset for the lightweight Next Lite compiler.",
        content: `# Serverless Next Lite Playground

This template targets the current Next Lite slice:

- app/layout.tsx wraps rendered pages
- app/page.tsx renders the root route
- app/posts/layout.tsx wraps the posts segment
- app/posts/[postId]/layout.tsx wraps the dynamic post detail segment
- app/posts/[postId]/page.tsx renders a dynamic route
- nested layout chains are discovered from root to leaf
- missing layout levels are skipped without blocking route discovery
- route groups (folder names like (marketing)) are hidden from the URL
- @slot and the literal _private segment are hidden from the URL
- page/layout files can use .tsx, .ts, .jsx, or .js
- params and searchParams are passed into page components
- app/**/route.ts handlers can return standard Web Response objects
- route handlers receive the original Request and decoded params context
- route handlers can import NextResponse from next/server for JSON responses

This route intentionally avoids CSS imports, next/link, next/navigation, client components, server actions, NextRequest, and RSC streaming until those are implemented in the lightweight compiler.`,
      },
      {
        path: "package.json",
        language: "json",
        description:
          "Project manifest for the lightweight Next Lite playground.",
        content: `{
  "name": "serverless-next-lite-playground",
  "private": true
}
`,
      },
      {
        path: "tsconfig.json",
        language: "json",
        description:
          "TypeScript configuration for the lightweight App Router subset.",
        content: `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx"
  },
  "include": ["app/**/*.ts", "app/**/*.tsx"]
}
`,
      },
      {
        path: "app/layout.tsx",
        language: "tsx",
        description: "Root layout for the Next Lite SSR subset.",
        content: `import type { CSSProperties, ReactNode } from "react";

const bodyStyle: CSSProperties = {
  margin: 0,
  background: "#f6f3ec",
  color: "#1d2320",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
};

const shellStyle: CSSProperties = {
  margin: "0 auto",
  maxWidth: 920,
  padding: "40px 20px",
};

const navStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  marginBottom: 32,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={bodyStyle}>
        <main style={shellStyle}>
          <nav style={navStyle}>
            <a href="/">Home</a>
            <a href="/posts/first-post?tab=notes">Dynamic post</a>
            <a href="/api/health">API health</a>
          </nav>
          {children}
        </main>
      </body>
    </html>
  );
}
`,
      },
      {
        path: "app/page.tsx",
        language: "tsx",
        description:
          "Root page rendered by the lightweight Next Lite compiler.",
        content: `import type { CSSProperties } from "react";

const panelStyle: CSSProperties = {
  border: "1px solid #d6d0c4",
  borderRadius: 8,
  background: "#fffdf8",
  padding: 28,
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: "#56625b",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0,
  textTransform: "uppercase",
};

export default function Page() {
  return (
    <section style={panelStyle}>
      <p style={eyebrowStyle}>Next Lite SSR</p>
      <h1>Page and layout are rendered by the lightweight compiler.</h1>
      <p>
        This is the first parity slice: server-rendered App Router pages,
        a root layout, dynamic route params, and search params.
      </p>
      <p>
        Open <a href="/posts/first-post?tab=notes">/posts/first-post?tab=notes</a>
        to test the dynamic route.
      </p>
    </section>
  );
}
`,
      },
      {
        path: "app/api/health/route.ts",
        language: "ts",
        description:
          "Route handler using the lightweight next/server response shim.",
        content: `import { NextResponse } from "next/server";

export function GET(request: Request) {
  const url = new URL(request.url);

  return NextResponse.json({
    ok: true,
    runtime: "next-lite",
    path: url.pathname,
  });
}
`,
      },
      {
        path: "app/posts/layout.tsx",
        language: "tsx",
        description: "Nested posts layout for the Next Lite SSR subset.",
        content: `import type { CSSProperties, ReactNode } from "react";

const postsShellStyle: CSSProperties = {
  borderLeft: "4px solid #537168",
  paddingLeft: 20,
};

const labelStyle: CSSProperties = {
  color: "#537168",
  fontSize: 13,
  fontWeight: 700,
  margin: "0 0 12px",
};

export default function PostsLayout({ children }: { children: ReactNode }) {
  return (
    <section style={postsShellStyle}>
      <p style={labelStyle}>Nested posts layout</p>
      {children}
    </section>
  );
}
`,
      },
      {
        path: "app/posts/[postId]/layout.tsx",
        language: "tsx",
        description: "Nested post detail layout for the Next Lite SSR subset.",
        content: `import type { CSSProperties, ReactNode } from "react";

const detailShellStyle: CSSProperties = {
  background: "#eff6f3",
  border: "1px solid #c9d7ca",
  borderRadius: 8,
  padding: 20,
};

const labelStyle: CSSProperties = {
  color: "#3f5d53",
  fontSize: 13,
  fontWeight: 700,
  margin: "0 0 12px",
};

export default function PostDetailLayout({ children }: { children: ReactNode }) {
  return (
    <section style={detailShellStyle}>
      <p style={labelStyle}>Dynamic post detail layout</p>
      {children}
    </section>
  );
}
`,
      },
      {
        path: "app/posts/[postId]/page.tsx",
        language: "tsx",
        description:
          "Dynamic page route rendered with params and searchParams.",
        content: `import type { CSSProperties } from "react";

type PageProps = {
  params: {
    postId: string;
  };
  searchParams: {
    tab?: string;
  };
};

const panelStyle: CSSProperties = {
  border: "1px solid #c9d7ca",
  borderRadius: 8,
  background: "#fbfffb",
  padding: 28,
};

export default function PostPage({ params, searchParams }: PageProps) {
  return (
    <section style={panelStyle}>
      <p>Dynamic route</p>
      <h1>Post: {params.postId}</h1>
      <p>Selected tab: {searchParams.tab ?? "overview"}</p>
      <p>
        Edit this file, save, then request another post id to verify that the
        compiled route matcher is using the current workspace snapshot.
      </p>
    </section>
  );
}
`,
      },
    ],
  },
  {
    id: "serverless-nextjs-runtime-playground",
    name: "Serverless Next Runtime Playground",
    previewPath: "app/page.tsx",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A stateless real-Next runtime experiment using a short-lived temp workspace.",
        content: `# Serverless Next Runtime Playground

This route is an experiment in running a real Next app without keeping a long-lived session runtime alive.

- A saved file snapshot is written into a temp workspace
- A short-lived child process boots Next for one request
- The response is captured and returned to the workbench
- The workspace is then abandoned for later cleanup

This is closer to real Next than the lightweight \`/serverless/nextjs\` route, but it is still request-scoped rather than an always-on dev server.`,
      },
      {
        path: "package.json",
        language: "json",
        description: "Project manifest for the experimental runtime.",
        content: `{
  "name": "serverless-nextjs-runtime-playground",
  "private": true
}
`,
      },
      {
        path: "tsconfig.json",
        language: "json",
        description: "TypeScript configuration for the experimental runtime.",
        content: `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
  "exclude": ["node_modules"]
}
`,
      },
      {
        path: "next-env.d.ts",
        language: "ts",
        description: "Next ambient types.",
        content: `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// This file is intentionally lightweight for the runtime experiment.
`,
      },
      {
        path: "app/layout.tsx",
        language: "tsx",
        description: "Root layout for the real runtime experiment.",
        content: `import type { ReactNode } from "react";
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
`,
      },
      {
        path: "app/page.tsx",
        language: "tsx",
        description: "A server component page for the runtime experiment.",
        content: `import Link from "next/link";

async function getGreeting() {
  return {
    text: "Hello from a real Next request runtime.",
    renderedAt: new Date().toISOString(),
  };
}

export default async function Page() {
  const greeting = await getGreeting();

  return (
    <main className="panel">
      <span className="eyebrow">Runtime experiment</span>
      <h1>{greeting.text}</h1>
      <p>
        This page is rendered by a short-lived Next process on the server. Save
        the file, send a request, and the workbench will capture the fresh HTML.
      </p>
      <div className="meta-grid">
        <article>
          <strong>Rendered at</strong>
          <span>{greeting.renderedAt}</span>
        </article>
        <article>
          <strong>API route</strong>
          <span>Try GET /api/hello in the request panel.</span>
        </article>
        <article>
          <strong>Tradeoff</strong>
          <span>No persistent dev server or HMR.</span>
        </article>
      </div>
      <Link className="cta" href="/api/hello">
        Open the JSON route
      </Link>
    </main>
  );
}
`,
      },
      {
        path: "app/api/hello/route.ts",
        language: "ts",
        description: "A simple route handler for API request testing.",
        content: `export async function GET() {
  return Response.json({
    ok: true,
    message: "Hello from app/api/hello/route.ts",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  return Response.json({
    ok: true,
    echo: body,
    timestamp: new Date().toISOString(),
  });
}
`,
      },
      {
        path: "app/globals.css",
        language: "css",
        description: "Styles for the runtime experiment.",
        content: `:root {
  color-scheme: light;
  --bg: #f3e6d5;
  --panel: rgba(255, 249, 241, 0.92);
  --ink: #251910;
  --accent: #c7622f;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(199, 98, 47, 0.18), transparent 22rem),
    linear-gradient(180deg, #fff7ef 0%, #ead3b7 100%);
}

.shell {
  width: min(900px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}

.panel {
  border-radius: 28px;
  border: 1px solid rgba(37, 25, 16, 0.08);
  background: var(--panel);
  box-shadow: 0 24px 60px rgba(56, 30, 12, 0.12);
  padding: 36px;
}

.eyebrow {
  display: inline-flex;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(199, 98, 47, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 16px 0 12px;
  font-size: clamp(38px, 6vw, 64px);
  line-height: 0.95;
}

p {
  margin: 0;
  max-width: 38rem;
  line-height: 1.6;
  font-size: 18px;
}

.meta-grid {
  display: grid;
  gap: 14px;
  margin-top: 22px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.meta-grid article {
  border-radius: 18px;
  padding: 18px;
  background: white;
  border: 1px solid rgba(37, 25, 16, 0.08);
}

.meta-grid strong {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 22px;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  background: #241911;
  color: white;
  text-decoration: none;
  font-weight: 600;
}
`,
      },
    ],
  },
  {
    id: "serverless-express-playground",
    name: "Serverless Express Playground",
    previewPath: "src/server.ts",
    files: [
      {
        path: "README.md",
        language: "md",
        description:
          "A stateless Express playground that compiles and serves one request at a time.",
        content: `# Serverless Express Playground

This workspace is stateless by design.

- No session filesystem on disk
- No long-lived Node process
- No terminal
- No installed session node_modules

Each preview request sends the current browser snapshot to the server, compiles the Express app with the selected compiler, starts it on an ephemeral port, proxies one request, then shuts it down again.`,
      },
      {
        path: "package.json",
        language: "json",
        description:
          "Informational manifest for the stateless Express playground.",
        content: `{
  "name": "serverless-express-playground",
  "private": true,
  "type": "module",
  "dependencies": {
    "express": "^5.2.1"
  }
}
`,
      },
      {
        path: "src/server.ts",
        language: "ts",
        description:
          "Express app entry exported for the stateless request runner.",
        content: `import express from "express";

const app = express();

app.use(express.json());

app.get("/", (_request, response) => {
  response
    .type("html")
    .send(\`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Serverless Express</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4e6d5;
        --panel: rgba(255, 249, 241, 0.92);
        --ink: #24180e;
        --accent: #b65e2a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(182, 94, 42, 0.2), transparent 22rem),
          linear-gradient(180deg, #fff8ef 0%, #ecd8bc 100%);
      }
      main {
        width: min(960px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }
      .hero, .card {
        border-radius: 28px;
        border: 1px solid rgba(36, 24, 14, 0.08);
        background: var(--panel);
        box-shadow: 0 24px 60px rgba(65, 35, 13, 0.12);
      }
      .hero { padding: 42px 34px 26px; }
      .badge {
        display: inline-flex;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(182, 94, 42, 0.12);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0 12px;
        font-size: clamp(42px, 7vw, 68px);
        line-height: 0.94;
      }
      p {
        margin: 0;
        max-width: 40rem;
        font-size: 18px;
        line-height: 1.6;
      }
      .grid {
        display: grid;
        gap: 16px;
        margin-top: 18px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .card { padding: 22px; }
      .card strong {
        display: block;
        margin-bottom: 10px;
        font-size: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="badge">Serverless Express</span>
        <h1>Stateless request, real Node handler.</h1>
        <p>
          This HTML was generated by an Express route compiled from the files in
          your browser, started on a short-lived Node server, requested once,
          then shut down.
        </p>
      </section>
      <section class="grid">
        <article class="card">
          <strong>Compile</strong>
          Pick esbuild, rolldown, or sucrase in the workbench to compile src/server.ts for each preview request.
        </article>
        <article class="card">
          <strong>Runtime</strong>
          Express handles one proxied request in an ephemeral Node process.
        </article>
        <article class="card">
          <strong>Next route</strong>
          Try /api/health in the path bar to hit a JSON endpoint instead of HTML.
        </article>
      </section>
    </main>
    <script>
      console.log("Serverless Express route rendered.");
    </script>
  </body>
</html>\`);
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    runtime: "serverless-express",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/echo", (request, response) => {
  response.json({
    ok: true,
    method: request.method,
    body: request.body,
    headers: {
      "content-type": request.header("content-type") ?? null,
    },
  });
});

export default app;
`,
      },
    ],
  },
  {
    id: "vite-react-starter",
    name: "Vite React Starter",
    previewPath: "index.html",
    files: [
      {
        path: "README.md",
        language: "md",
        description: "A short guide for the Vite + React workspace.",
        content: `# Vite React Starter

This workspace is intended for the host-backed Vite runtime.

- Edit TypeScript React files in the browser
- Save them to the session workspace on disk
- Session dependencies are installed from this workspace package.json
- Monaco is configured for TypeScript, JSX, and the starter libraries

HMR is intentionally disabled for now, so the preview contract stays HTTP-only.`,
      },
      {
        path: "package.json",
        language: "json",
        description: "Vite workspace package manifest.",
        content: `{
  "name": "vite-react-starter",
  "private": true,
  "type": "module",
  "dependencies": {
    "lucide-react": "^0.577.0",
    "motion": "^12.38.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "typescript": "^5.9.3",
    "vite": "^8.0.1"
  },
  "scripts": {
    "dev": "vite"
  }
}
`,
      },
      {
        path: "vite.config.mjs",
        language: "js",
        description: "Vite config with HMR disabled for simple proxying.",
        content: `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.TUTO_VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    hmr: false,
    watch: {
      usePolling: true,
    },
  },
});
`,
      },
      {
        path: "index.html",
        language: "html",
        description: "Vite entry HTML document.",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite React Workspace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
      },
      {
        path: "tsconfig.json",
        language: "json",
        description: "TypeScript config for the Vite workspace.",
        content: `{
  "compilerOptions": {
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Node",
    "noEmit": true,
    "strict": true,
    "target": "ES2022"
  },
  "include": ["src"]
}
`,
      },
      {
        path: "src/main.tsx",
        language: "tsx",
        description: "Client entry point for the React app.",
        content: `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
      },
      {
        path: "src/App.tsx",
        language: "tsx",
        description: "Main React component rendered by Vite.",
        content: `import { ArrowUpRight, Boxes, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";

type Card = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const cards: Card[] = [
  {
    icon: Sparkles,
    title: "Libraries",
    body: "This starter imports motion and lucide-react from the session workspace.",
  },
  {
    icon: Boxes,
    title: "Workspace",
    body: "Edit package.json, src/App.tsx, or src/styles.css and the host-backed runtime will pick it up.",
  },
  {
    icon: ArrowUpRight,
    title: "Next Step",
    body: "Use this runtime to prove dependency installs before moving back toward richer dev-server flows.",
  },
];

export default function App() {
  return (
    <main className="page-shell">
      <motion.section
        className="hero-card"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <span className="eyebrow">Vite + React</span>
        <h1>Monaco + TypeScript, running live.</h1>
        <p>
          This preview is now served by a host-backed Vite dev server with real
          workspace installs, a TypeScript starter, and Monaco in the control
          plane.
        </p>
      </motion.section>
      <section className="grid">
        {cards.map(({ body, icon: Icon, title }, index) => (
          <motion.article
            key={title}
            className="panel"
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 * (index + 1), duration: 0.4, ease: "easeOut" }}
          >
            <div className="panel-icon">
              <Icon size={18} strokeWidth={2.2} />
            </div>
            <strong>{title}</strong>
            <p>{body}</p>
          </motion.article>
        ))}
      </section>
    </main>
  );
}
`,
      },
      {
        path: "src/styles.css",
        language: "css",
        description: "Styles for the Vite React starter app.",
        content: `:root {
  color-scheme: light;
  --ink: #1d1812;
  --cream: #fff7ec;
  --sand: #f0dfc4;
  --accent: #d06a2f;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(208, 106, 47, 0.18), transparent 24rem),
    linear-gradient(180deg, #fffaf1 0%, #f6ead6 100%);
}

.page-shell {
  width: min(960px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0 48px;
}

.hero-card,
.panel {
  border: 1px solid rgba(29, 24, 18, 0.08);
  border-radius: 28px;
  background: rgba(255, 247, 236, 0.88);
  box-shadow: 0 24px 60px rgba(64, 36, 15, 0.12);
}

.hero-card {
  padding: 48px 36px 28px;
}

.eyebrow {
  display: inline-flex;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(208, 106, 47, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 18px 0 12px;
  font-size: clamp(40px, 7vw, 68px);
  line-height: 0.95;
}

p {
  margin: 0;
  max-width: 40rem;
  font-size: 18px;
  line-height: 1.6;
}

.grid {
  display: grid;
  gap: 16px;
  margin-top: 18px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.panel {
  padding: 22px;
}

.panel strong {
  display: block;
  margin: 14px 0 10px;
  font-size: 14px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.panel p {
  font-size: 16px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: rgba(208, 106, 47, 0.12);
  color: var(--accent);
}
`,
      },
    ],
  },
];

export function listTemplates() {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    previewPath: template.previewPath,
  }));
}

export function getTemplate(templateId = templates[0]?.id) {
  return templates.find((template) => template.id === templateId) ?? null;
}

export function getServerlessTemplate() {
  return getTemplate("serverless-react-playground");
}

export function getServerlessNextjsTemplate() {
  return getTemplate("serverless-nextjs-playground");
}

export function getServerlessNextLiteTemplate() {
  return getTemplate("serverless-next-lite-playground");
}

export function getServerlessTanstackStartTemplate() {
  return getTemplate("serverless-tanstack-start-playground");
}

export function getServerlessNextjsRuntimeTemplate() {
  return getTemplate("serverless-nextjs-runtime-playground");
}

export function getServerlessExpressTemplate() {
  return getTemplate("serverless-express-playground");
}
