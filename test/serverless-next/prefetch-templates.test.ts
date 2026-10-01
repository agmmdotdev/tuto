import {afterEach,expect,test} from "vitest";
import {createRequire} from "node:module";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
const createRouter=createRequire(import.meta.url)("../../lib/serverless-next/client-router.cjs");
afterEach(()=>Reflect.deleteProperty(globalThis,"__TUTO_NEXT_SEGMENT_ACCEPT__"));
test("prefetch inspects lazy Flight elements without invoking client components and selects only granted shell templates",async()=>{
 const router=createRouter(React);let calls=0;
 function Client():never{calls++;throw new Error("speculative component must not render");}
 const template=React.createElement(Client);
 const segment=(key:string,cacheable=true)=>React.createElement(router.LayoutSegment,{cacheKey:key,cacheable,template,slots:{}});
 const root=React.lazy(async()=>({default:()=>null}));
 // Flight lazy values resolve to models/references rather than component defaults.
 const lazy={$$typeof:Symbol.for("react.lazy"),_payload:null,_init:()=>[segment("allowed"),segment("forged"),segment("fresh",false)]};
 const models=await router.collectSegments([root,lazy],["allowed","fresh"]);
 expect(calls).toBe(0);expect([...models.keys()]).toEqual(["allowed"]);
 Object.assign(globalThis,{__TUTO_NEXT_SEGMENT_ACCEPT__:(key:string)=>key==="allowed"});router.storeSegments(models);
 expect(router.pinSegments("prefetch")).toEqual(["allowed"]);
});
test("failed or cancelled speculative traversal cannot publish a partial graph",async()=>{
 const router=createRouter(React);const invalid={$$typeof:Symbol.for("react.lazy"),_init:()=>{throw new Error("invalid Flight");}};
 const valid=React.createElement(router.LayoutSegment,{cacheKey:"key",cacheable:true,template:"safe",slots:{}});
 await expect(router.collectSegments([invalid,valid],["key"])).rejects.toThrow("invalid Flight");
 expect(router.pinSegments("failed")).toEqual([]);
 await expect(router.collectSegments(valid,["key"],()=>true)).rejects.toThrow("cancelled");
 await expect(router.collectSegments(Array.from({length:4097},()=>({})),[])).rejects.toThrow("bound");
 const cycle={$$typeof:Symbol.for("react.lazy"),_init:()=>cycle};await expect(router.collectSegments(cycle,[])).rejects.toThrow("bound");
});
test("grant acceptance gates insertion, the map stays bounded and pins survive eviction/invalidation",()=>{
 const router=createRouter(React);Object.assign(globalThis,{__TUTO_NEXT_SEGMENT_ACCEPT__:(key:string)=>key!=="rejected"});
 router.storeSegments(new Map([["first","first template"],["rejected","must not cache"]]));expect(router.pinSegments("active")).toEqual(["first"]);
 router.storeSegments(new Map(Array.from({length:16},(_,i)=>["new"+i,"template"+i])));expect(router.pinSegments("new")).toHaveLength(16);
 router.pinSegments("active");router.clearSegments();
 expect(renderToStaticMarkup(React.createElement(router.LayoutSegment,{cacheKey:"first",requestId:"active",slots:{}}))).toBe("first template");
 router.releaseSegments("active");expect(()=>renderToStaticMarkup(React.createElement(router.LayoutSegment,{cacheKey:"first",requestId:"active",slots:{}}))).toThrow("no longer available");
});
