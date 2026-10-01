"use strict";

// One active Link task and eight pending destinations per preview document.
module.exports = function createPrefetchScheduler({ key, prefetch, busy, Observer = globalThis.IntersectionObserver }) {
  const records = new Map();
  const queued = new Map();
  let active;
  let timer;
  let sequence = 0;
  let epoch = 0;
  let disposed = false;
  const interested = record => !record.removed && (record.visible || !record.seen && record.intent);
  function cancelUnused(job) {
    for (const record of job.sources) if (!interested(record)) job.sources.delete(record);
    if (job.sources.size) return;
    if (job === active) job.controller.abort();
    else queued.delete(job.key);
  }
  function offer(record, intent = false) {
    if (disposed || !interested(record)) return;
    const value = key(record.href, record.mode);
    if (!value || !intent && record.attempted === value) return;
    let job = active?.key === value ? active : queued.get(value);
    if (!job) {
      job = { key:value, href:record.href, mode:record.mode, sources:new Set(), priority:0, sequence:0 };
      queued.set(value, job);
    }
    job.sources.add(record);
    job.priority = Math.max(job.priority, intent ? 1 : 0);
    job.sequence = ++sequence;
    while (queued.size > 8) {
      const victim = [...queued.values()].sort((a,b) => a.priority-b.priority || a.sequence-b.sequence)[0];
      queued.delete(victim.key);
      for (const source of victim.sources) source.attempted = victim.key;
    }
    if (intent && active && active !== job && active.priority === 0) active.controller.abort();
    schedule();
  }
  function collect() {
    // Reverse insertion order gives the earlier DOM links priority in a burst.
    for (const record of [...records.values()].reverse()) offer(record);
  }
  function schedule() {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; pump(); }, 0);
  }
  function pump() {
    if (disposed || active || busy()) return;
    const job = [...queued.values()].sort((a,b) => b.priority-a.priority || b.sequence-a.sequence)[0];
    if (!job) return;
    queued.delete(job.key);
    cancelUnused(job);
    if (!job.sources.size) { schedule(); return; }
    // A queued task must be rebuilt after any request-context change.
    if (key(job.href,job.mode) !== job.key) { collect(); schedule(); return; }
    active = job;
    job.controller = new AbortController();
    const generation = epoch;
    Promise.resolve().then(() => prefetch(job.href, { _prefetchMode:job.mode, _signal:job.controller.signal }))
      .catch(error => { if (error.name !== "AbortError") console.error(error); })
      .finally(() => {
        if (generation === epoch && !job.controller.signal.aborted) {
          for (const record of job.sources) record.attempted = job.key;
        }
        if (active === job) active = undefined;
        collect(); schedule();
      });
  }
  const observer = Observer ? new Observer(entries => {
    for (const entry of [...entries].reverse()) {
      const record = records.get(entry.target);
      if (!record) continue;
      record.seen = true;
      record.visible = entry.intersectionRatio > 0;
      if (record.visible) { record.intent = false; offer(record); }
      else {
        record.intent = false;
        record.attempted = undefined;
        for (const job of queued.values()) cancelUnused(job);
        if (active) cancelUnused(active);
      }
    }
  }, {rootMargin:"0px"}) : undefined;
  return {
    observe(element, href, mode) {
      const record = { element, href, mode, visible:false, seen:false, intent:false, removed:false };
      records.set(element,record);
      observer?.observe(element);
      return {
        intent() { record.intent = true; offer(record,true); },
        dispose() {
          if (record.removed) return;
          record.removed = true;
          if (records.get(element) === record) records.delete(element);
          observer?.unobserve(element);
          for (const job of queued.values()) cancelUnused(job);
          if (active) cancelUnused(active);
        },
      };
    },
    pause() {
      epoch++;
      queued.clear();
      active?.controller.abort();
      for (const record of records.values()) {
        record.attempted = undefined;
        if (!Observer) record.intent = false;
      }
    },
    resume() { collect(); schedule(); },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      queued.clear();
      active?.controller.abort();
      observer?.disconnect();
      records.clear();
    },
  };
};
