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
