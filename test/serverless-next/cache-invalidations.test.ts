import { expect, test } from "vitest";
import { NextCacheInvalidations, nextCacheInvalidations } from "../../lib/serverless-next/cache-invalidations";
import { NextPrefetchTickets } from "../../lib/serverless-next/prefetch";
import { getNextCacheAdapter, revalidateNextCacheTags, setNextCacheAdapter } from "../../lib/serverless-next/cache-adapter";
import type { NextRequestArtifact } from "../../lib/serverless-next/artifact";

test("workspace mutation fences reject old and in-flight tickets/grants across artifacts and owners", () => {
  const tickets = new NextPrefetchTickets();
  const a = {workspaceKey:"fence-workspace",revision:"a",generation:"a"} as NextRequestArtifact;
  const b = {...a,revision:"b",generation:"b"} as NextRequestArtifact;
  const other = {...a,workspaceKey:"fence-other"} as NextRequestArtifact;
  const put = (artifact:NextRequestArtifact,owner="one",epoch=tickets.epoch(artifact)) => tickets.put({artifact,owner,epoch,key:"key",body:new Uint8Array([1]),headers:[],status:200});
  const oldEpoch = tickets.epoch(a), first=put(a)!, second=put(b,"two")!, isolated=put(other)!;
  const context=tickets.segmentContext(a,"one",{});
  const grant=tickets.issueSegments(a,"one",{},[{key:context+":layout",slots:[]}])!;
  const finish=nextCacheInvalidations.begin(a.workspaceKey);
  expect(tickets.take(first,a,"one","key")).toBeNull();
  expect(tickets.resolveSegments(a,"one",{},[grant])).toEqual([]);
  expect(tickets.issueSegments(a,"one",{},[{key:context+":layout",slots:[]}])).toBeUndefined();
  expect(put(a)).toBeNull();
  const duringEpoch=tickets.epoch(a);
  finish();
  expect(put(a,"one",oldEpoch)).toBeNull();
  expect(put(a,"one",duringEpoch)).toBeNull();
  expect(tickets.take(second,b,"two","key")).toBeNull();
  expect(tickets.take(isolated,other,"one","key")).not.toBeNull();
  expect(tickets.resolveSegments(a,"one",{},[grant])).toEqual([]);
  expect(put(a)).not.toBeNull();
});

test("bounded idle workspace eviction forces misses, while overlapping mutations stay fenced", () => {
  const versions = new NextCacheInvalidations();
  const old=versions.version("old"), busy=versions.version("busy");
  const finishOne=versions.begin("busy"),finishTwo=versions.begin("busy");
  for(let i=0;i<140;i++)versions.version("workspace-"+i);
  expect(versions.version("old")).not.toBe(old);
  expect(versions.version("busy")).not.toBe(busy);
  finishOne();expect(versions.pending("busy")).toBe(true);
  const during=versions.version("busy");finishTwo();
  expect(versions.pending("busy")).toBe(false);expect(versions.version("busy")).not.toBe(during);
});

test("adapter profiles are unchanged and a partially failed invalidation cannot resurrect tickets", async () => {
  const adapter=getNextCacheAdapter();
  let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const input={workspaceKey:"failed-mutation",tags:["posts"],durations:{expire:0}};
  const received:unknown[]=[];
  setNextCacheAdapter({
    acquireLock:adapter.acquireLock.bind(adapter),get:adapter.get.bind(adapter),
    releaseLock:adapter.releaseLock.bind(adapter),set:adapter.set.bind(adapter),
    async revalidateTags(value){received.push(value);await wait;throw new Error("partial coordinator failure");},
  });
  try {
    const before=nextCacheInvalidations.version(input.workspaceKey);
    const operation=revalidateNextCacheTags(input);
    expect(nextCacheInvalidations.pending(input.workspaceKey)).toBe(true);
    const during=nextCacheInvalidations.version(input.workspaceKey);
    expect(during).not.toBe(before);release();
    await expect(operation).rejects.toThrow("partial coordinator failure");
    expect(received).toEqual([input]);expect(nextCacheInvalidations.pending(input.workspaceKey)).toBe(false);
    expect(nextCacheInvalidations.version(input.workspaceKey)).not.toBe(during);
  } finally {setNextCacheAdapter(adapter);}
});

test("selective journals fence overlap, partial failure and lost history without trusting incomplete dependencies", () => {
  const journal = new NextCacheInvalidations();
  const known = {complete:true,tags:["posts","_N_T_/blog/page"]};
  const snapshot=journal.snapshot("selective");
  const first=journal.begin("selective",["unrelated"]),second=journal.begin("selective",["also-unrelated"]);
  expect(journal.valid("selective",snapshot,known)).toBe(false);
  first();expect(journal.valid("selective",snapshot,known)).toBe(false);
  second();expect(journal.valid("selective",snapshot,known)).toBe(true);
  expect(journal.valid("selective",snapshot)).toBe(false);
  expect(journal.valid("selective",snapshot,{complete:false,tags:known.tags})).toBe(false);
  expect(journal.valid("selective",snapshot,{complete:true,tags:[]})).toBe(false);
  const during=journal.snapshot("selective"),finish=journal.begin("selective",["posts"]);
  const partial=journal.snapshot("selective");finish();finish();
  expect(journal.valid("selective",snapshot,known)).toBe(false);
  expect(journal.valid("selective",during,known)).toBe(false);
  expect(journal.valid("selective",partial,known)).toBe(false);
  const bounded=journal.snapshot("bounded");
  for(let i=0;i<65;i++)journal.begin("bounded",["unrelated"])();
  expect(journal.valid("bounded",bounded,known)).toBe(false);
  const evicted=journal.snapshot("evicted");
  for(let i=0;i<140;i++)journal.snapshot("idle-"+i);
  expect(journal.valid("evicted",evicted,known)).toBe(false);
});

test("complete full tickets stay selective across artifacts and owners; refresh and unknown mutation remain broad", () => {
  const tickets=new NextPrefetchTickets();
  const a={workspaceKey:"selective-ticket",revision:"a",generation:"a"} as NextRequestArtifact;
  const b={...a,revision:"b",generation:"b"} as NextRequestArtifact;
  const put=(artifact:NextRequestArtifact,owner:string,tags:string[])=>tickets.put({artifact,owner,epoch:tickets.epoch(artifact),snapshot:nextCacheInvalidations.snapshot(artifact.workspaceKey),dependencies:{complete:true,tags},key:"key",body:new Uint8Array([1]),headers:[],status:200})!;
  const one=put(a,"one",["affected"]),two=put(a,"two",["independent"]),another=put(b,"one",["independent"]);
  nextCacheInvalidations.begin(a.workspaceKey,["affected"])();
  expect(tickets.take(one,a,"one","key")).toBeNull();
  expect(tickets.take(two,a,"one","key")).toBeNull();
  expect(tickets.take(two,a,"two","key")).not.toBeNull();
  expect(tickets.take(another,b,"one","key")).not.toBeNull();
  const refresh=put(a,"one",["independent"]);tickets.invalidate(a);
  expect(tickets.take(refresh,a,"one","key")).toBeNull();
  const shellTicket=tickets.put({artifact:a,owner:"one",epoch:tickets.epoch(a),key:"shell",body:new Uint8Array([1]),headers:[],status:200,kind:"shell"})!;
  const consumedShell=tickets.take(shellTicket,a,"one","shell")!;
  expect(tickets.current(consumedShell)).toBe(true);
  const shellEpoch=tickets.epoch(a);nextCacheInvalidations.begin(a.workspaceKey,["unrelated"])();
  expect(tickets.epoch(a)).toBe(shellEpoch);expect(tickets.current(consumedShell)).toBe(false);
  const unknown=put(a,"one",["independent"]);nextCacheInvalidations.begin(a.workspaceKey)();
  expect(tickets.take(unknown,a,"one","key")).toBeNull();
});
