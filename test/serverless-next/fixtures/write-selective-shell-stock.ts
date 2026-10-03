import { mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { selectiveShellWorkspace } from "./selective-shell-workspace";
// Run the bundled fixture writer from the repository root. Keep stock probes
// distinct from Tuto's render counters: Next can persist build-time values while
// resetting module counters when its production server starts.
if (!process.argv[2])
  throw new Error("Supply a disposable stock fixture directory.");
const root = resolve(process.argv[2]);
for (const file of selectiveShellWorkspace()) {
  let content = file.content;
  content = content
    .replace(/return \+\+rootReads/g, "return Date.now()")
    .replace(/return \+\+loadingReads/g, "return Date.now()")
    .replace(/async\(\)=>\+\+layoutReads/g, "async()=>Date.now()");
  if (file.path === "app/layout.tsx")
    content =
      'import {Suspense} from "react";\n' +
      content
        .replace("<body>", "<body><Suspense fallback={<p>stock loading</p>}>")
        .replace("</body>", "</Suspense></body>");
  if (file.path === "app/dashboard/shell/nested/page.tsx")
    content =
      "export default function Page(){return <p>deferred nested page</p>;}";
  if (
    file.path.endsWith("/page.tsx") &&
    content.includes("export default async function Page()")
  )
    content =
      'import {cookies as stockCookies} from "next/headers";\n' +
      content.replace(
        "export default async function Page(){",
        "export default async function Page(){await stockCookies();",
      );
  if (file.path === "app/dashboard/shared/layout.tsx")
    content =
      'import {cookies as stockCookies} from "next/headers";\n' +
      content.replace(
        "export default async function Layout({children}){",
        "export default async function Layout({children}){await stockCookies();",
      );
  const p = root + "/" + file.path;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
writeFileSync(
  root + "/package.json",
  JSON.stringify({
    name: "selective-stock",
    private: true,
    dependencies: { next: "16.3.6", react: "19.2.6", "react-dom": "19.2.6" },
  }),
);
writeFileSync(
  root + "/next.config.js",
  "module.exports={cacheComponents:true,typescript:{ignoreBuildErrors:true},experimental:{cpus:2}}",
);
if (!existsSync(root + "/node_modules"))
  symlinkSync(resolve("node_modules"), root + "/node_modules", "dir");
