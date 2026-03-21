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
        description: "The main preview document served by the workspace server.",
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
        description: "A stateless playground that compiles from the current browser snapshot.",
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
        description: "A stateless App Router-like playground built on the shared esbuild compiler.",
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
        description: "The main App Router page for the stateless Next-style app.",
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
    id: "serverless-nextjs-runtime-playground",
    name: "Serverless Next Runtime Playground",
    previewPath: "app/page.tsx",
    files: [
      {
        path: "README.md",
        language: "md",
        description: "A stateless real-Next runtime experiment using a short-lived temp workspace.",
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
        description: "A stateless Express playground that compiles and serves one request at a time.",
        content: `# Serverless Express Playground

This workspace is stateless by design.

- No session filesystem on disk
- No long-lived Node process
- No terminal
- No installed session node_modules

Each preview request sends the current browser snapshot to the server, bundles the Express app with esbuild, starts it on an ephemeral port, proxies one request, then shuts it down again.`,
      },
      {
        path: "package.json",
        language: "json",
        description: "Informational manifest for the stateless Express playground.",
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
        description: "Express app entry exported for the stateless request runner.",
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
          esbuild bundles src/server.ts on the server for each preview request.
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

export function getServerlessNextjsRuntimeTemplate() {
  return getTemplate("serverless-nextjs-runtime-playground");
}

export function getServerlessExpressTemplate() {
  return getTemplate("serverless-express-playground");
}
