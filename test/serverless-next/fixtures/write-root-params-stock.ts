import { mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rootParamsWorkspace } from "./root-params-workspace";
if (!process.argv[2]) throw new Error("Supply a disposable stock fixture directory.");
const root = resolve(process.argv[2]);
function write(path: string, content: string) {
  const target = root + "/" + path;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
for (const file of rootParamsWorkspace()) {
  let content = file.content;
  if (file.path.endsWith("/layout.tsx")) {
    const sample = file.path.includes("[tenant]") ? '{tenant:"seed"}' : file.path.includes("[region]") ? '{region:"seed"}' : '{parts:["seed"]}';
    content = 'import {Suspense} from "react";\nexport function generateStaticParams(){return [' + sample + '];}\n' + content
      .replace("{children}{side}", '<Suspense fallback={<p>stock loading</p>}>{children}{side}</Suspense>');
    if (!file.path.includes("[tenant]")) content = content.replace("{children}</body>", '<Suspense fallback={<p>stock loading</p>}>{children}</Suspense></body>');
  }
  write(file.path, content);
}
write("package.json", JSON.stringify({ name: "root-params-stock", private: true, dependencies: { next: "16.3.6", react: "19.2.6", "react-dom": "19.2.6" } }));
write("next.config.js", "module.exports={cacheComponents:true,experimental:{cpus:2}}");
if (!existsSync(root + "/node_modules")) symlinkSync(resolve("node_modules"), root + "/node_modules", "dir");
