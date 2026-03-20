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
