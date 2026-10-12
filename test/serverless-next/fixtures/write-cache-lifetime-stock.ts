import { mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cacheLifetimeParityWorkspace } from "./cache-lifetime-parity-workspace";

if (!process.argv[2]) throw new Error("Supply a disposable stock fixture directory.");
const root = resolve(process.argv[2]);
function write(path: string, content: string) {
  const target = root + "/" + path;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
for (const file of cacheLifetimeParityWorkspace()) {
  // Separate roots let the dynamic tenant be a real root parameter. No test
  // uses root params inside a Route Handler (unsupported by stock Next too).
  let path = file.path;
  if (path === "app/layout.tsx") path = "app/(plain)/layout.tsx";
  if (path === "app/page.tsx") path = "app/(plain)/page.tsx";
  if (path.startsWith("app/show/")) path = path.replace("app/show/", "app/(plain)/show/");
  let content = file.content;
  if (path.endsWith("/layout.tsx")) content = 'import {Suspense} from "react";\n' + content.replace("<body>{children}</body>", "<body><Suspense fallback={<p>stock loading</p>}>{children}</Suspense></body>");
  if (path.startsWith("app/(plain)/show/")) content = content.replace('"../../../cache-data"', '"../../../../cache-data"');
  write(path, content);
}
write("app/(partition)/[tenant]/layout.tsx", 'import {Suspense} from "react";export function generateStaticParams(){return [{tenant:"seed"}];}export default function Layout({children}){return <html><body><Suspense fallback={<p>partition loading</p>}>{children}</Suspense></body></html>;}');
write("app/root-cache.ts", `import {tenant} from "next/root-params";import {cacheLife,cacheTag} from "next/cache";
const counts=new Map();export async function partition(){"use cache";cacheLife({stale:10,revalidate:2,expire:4});const id=await tenant();cacheTag("root-partition-"+id);await new Promise(resolve=>setTimeout(resolve,60));const value=(counts.get(id)??0)+1;counts.set(id,value);return {id,value};}`);
write("app/(partition)/[tenant]/page.tsx", 'import {connection} from "next/server";import {partition} from "../../root-cache";export default async function Page(){await connection();return <output data-root-partition>{JSON.stringify(await partition())}</output>;}');
write("package.json", JSON.stringify({ name: "cache-lifetime-stock", private: true, dependencies: { next: "16.3.6", react: "19.2.6", "react-dom": "19.2.6" } }));
write("next.config.js", "module.exports={cacheComponents:true,typescript:{ignoreBuildErrors:true},experimental:{cpus:2}}");
if (!existsSync(root + "/node_modules")) symlinkSync(resolve("node_modules"), root + "/node_modules", "dir");
