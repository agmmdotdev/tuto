import {mkdirSync,writeFileSync,symlinkSync,existsSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {encodedParamsWorkspace} from "./encoded-params-workspace";
if(!process.argv[2])throw new Error("Supply a disposable stock fixture directory.");
const root=resolve(process.argv[2]);
function write(path:string,content:string){const target=root+"/"+path;mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);}
for(const file of encodedParamsWorkspace()){
  const content=file.path==="app/(workspace)/[tenant]/layout.tsx"?'import {Suspense} from "react";export function generateStaticParams(){return [{tenant:"seed"}];}'+file.content.replace("<Counter/><Client/><Controls/>{children}",'<Suspense fallback={<p>stock loading</p>}><Counter/><Client/><Controls/>{children}</Suspense>'):file.content;
  write(file.path,content);
}
write("package.json",JSON.stringify({name:"encoded-params-stock",private:true,dependencies:{next:"16.3.6",react:"19.2.6","react-dom":"19.2.6"}}));
write("next.config.js","module.exports={cacheComponents:true,experimental:{cpus:2}}");
if(!existsSync(root+"/node_modules"))symlinkSync(resolve("node_modules"),root+"/node_modules","dir");
