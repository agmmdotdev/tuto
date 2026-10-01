import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRequire} from "node:module";
const createScheduler = createRequire(import.meta.url)("../../lib/serverless-next/prefetch-scheduler.cjs");
type Job = {href:string;signal:AbortSignal;resolve:()=>void};
function setup(observer=true){
 let report:(entries:unknown[])=>void = ()=>{};
 const jobs:Job[]=[];
 let blocked=false,context="one";
 class Observer {
  constructor(callback:typeof report){report=callback;}
  observe(){} unobserve(){} disconnect(){}
 }
 const scheduler=createScheduler({
  Observer:observer?Observer:null,
  key:(href:string)=>context+href,
  busy:()=>blocked,
  prefetch:(href:string,options:{_signal:AbortSignal})=>new Promise<void>(resolve=>{
   jobs.push({href,signal:options._signal,resolve});
   options._signal.addEventListener("abort",()=>resolve(),{once:true});
  }),
 });
 const elements:object[]=[];
 const add=(href:string)=>{const element={};elements.push(element);return scheduler.observe(element,href,"auto");};
 const visible=(indexes:number[],show=true)=>report(indexes.map(index=>({target:elements[index],intersectionRatio:show?1:0})));
 return {scheduler,jobs,add,visible,block:()=>{blocked=true;},unblock:()=>{blocked=false;scheduler.resume();},context:()=>{context="two";scheduler.pause();scheduler.resume();}};
}
const tick=async()=>{await vi.advanceTimersByTimeAsync(1);};
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe("bounded Link prefetch scheduling",()=>{
 it("only warms visible links, prioritizes earlier links in a visibility batch and deduplicates destinations",async()=>{
  const s=setup();s.add("/a");s.add("/b");s.add("/a");s.visible([0,1,2]);await tick();
  expect(s.jobs.map(j=>j.href)).toEqual(["/a"]);s.jobs[0].resolve();await tick();expect(s.jobs.map(j=>j.href)).toEqual(["/a","/b"]);
  s.jobs[1].resolve();await tick();expect(s.jobs).toHaveLength(2);s.scheduler.dispose();
 });
 it("bounds a blocked queue to eight destinations",async()=>{
  const s=setup();s.block();for(let i=0;i<20;i++)s.add("/"+i);s.visible(Array.from({length:20},(_,i)=>i));await tick();expect(s.jobs).toHaveLength(0);
  s.unblock();for(let i=0;i<8;i++){await tick();s.jobs[i].resolve();}await tick();expect(s.jobs).toHaveLength(8);s.scheduler.dispose();
 });
 it("intent preempts viewport work and runs before queued viewport destinations",async()=>{
  const s=setup();s.add("/a");s.add("/b");const intent=s.add("/c");s.visible([0,1,2]);await tick();intent.intent();await tick();
  expect(s.jobs[0].signal.aborted).toBe(true);expect(s.jobs[1].href).toBe("/c");s.scheduler.dispose();
 });
 it("keeps a shared destination alive until every visible source leaves",async()=>{
  const s=setup();s.add("/a");const second=s.add("/a");s.visible([0,1]);await tick();s.visible([0],false);expect(s.jobs[0].signal.aborted).toBe(false);
  second.dispose();await tick();expect(s.jobs[0].signal.aborted).toBe(true);s.scheduler.dispose();
 });
 it("removes pending off-screen destinations",async()=>{
  const s=setup();s.add("/a");s.add("/b");s.visible([0,1]);await tick();s.visible([1],false);s.jobs[0].resolve();await tick();expect(s.jobs).toHaveLength(1);s.scheduler.dispose();
 });
 it("pauses for navigation and rekeys visible work after context invalidation",async()=>{
  const s=setup();s.add("/a");s.visible([0]);await tick();s.block();s.context();await tick();expect(s.jobs[0].signal.aborted).toBe(true);expect(s.jobs).toHaveLength(1);
  s.unblock();await tick();expect(s.jobs).toHaveLength(2);s.jobs[1].resolve();await tick();expect(s.jobs).toHaveLength(2);s.scheduler.dispose();
 });
 it("supports intent-only fallback without an observer and retries a repeated intent",async()=>{
  const s=setup(false);const a=s.add("/a");await tick();expect(s.jobs).toHaveLength(0);a.intent();await tick();s.jobs[0].resolve();await tick();expect(s.jobs).toHaveLength(1);
  a.intent();await tick();expect(s.jobs).toHaveLength(2);s.scheduler.dispose();
 });
 it("without an observer, invalidation waits for another intent rather than replaying hidden Links",async()=>{
  const s=setup(false);const a=s.add("/a");a.intent();await tick();s.jobs[0].resolve();await tick();s.context();await tick();expect(s.jobs).toHaveLength(1);
  a.intent();await tick();expect(s.jobs).toHaveLength(2);s.scheduler.dispose();
 });
 it("disposal aborts active work and prevents stale completion from requeuing",async()=>{
  const s=setup();s.add("/a");s.visible([0]);await tick();s.scheduler.dispose();await tick();expect(s.jobs[0].signal.aborted).toBe(true);expect(s.jobs).toHaveLength(1);
 });
});
