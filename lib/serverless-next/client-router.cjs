"use strict";

// Shared by the browser kernel and SSR decoder so context boundaries hydrate identically.
module.exports = function createPreviewRouter(React) {
  const LayoutContext = React.createContext({ params: {}, segments: {} });
  const ParamsContext = React.createContext({});
  const listeners = new Set();
  const currentUrl = () => globalThis.__TUTO_NEXT_URL__ || "/";
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function setUrl(url) {
    globalThis.__TUTO_NEXT_URL__ = url;
    for (const listener of listeners) listener();
  }
  function useUrl() {
    return new URL(React.useSyncExternalStore(subscribe, currentUrl, currentUrl), "http://next.local");
  }
  function navigate(kind, href, options) {
    const target = new URL(href === undefined ? currentUrl() : String(href), new URL(currentUrl(), "http://next.local"));
    if (target.origin !== "http://next.local") return false;
    const transport = globalThis.__TUTO_NEXT_NAVIGATE__;
    if (typeof transport !== "function") return false;
    transport(kind, target.pathname + target.search + target.hash, options);
    return true;
  }
  function RouterRoot({ state, params, children }) {
    React.useEffect(() => {
      globalThis.__TUTO_NEXT_ROUTER_STATE__ = state;
    }, [state]);
    return React.createElement(ParamsContext.Provider, { value: params }, children);
  }
  function LayoutScope({ value, children }) {
    return React.createElement(LayoutContext.Provider, { value }, children);
  }
  function PageScope({ params, children }) {
    return React.createElement(LayoutContext.Provider, { value: {params, segments: {}} }, children);
  }
  function BranchCache({ branchKey, children }) {
    const [cache, setCache] = React.useState(() => ({
      key: branchKey, child: children, entries: new Map([[branchKey, children]]),
    }));
    let entries = cache.entries;
    if (cache.key !== branchKey || cache.child !== children) {
      entries = new Map(entries);
      entries.delete(branchKey);
      entries.set(branchKey, children);
      // A preview has a bounded working set; evicted branches remount on return.
      while (entries.size > 8) entries.delete(entries.keys().next().value);
      setCache({ key: branchKey, child: children, entries });
    }
    return React.createElement(React.Fragment, null, [...entries].map(([key, child]) =>
      React.createElement(React.Activity, { key, mode: key === branchKey ? "visible" : "hidden" }, child),
    ));
  }
  class ReadonlySearchParams extends URLSearchParams {
    append() { throw new Error("ReadonlyURLSearchParams cannot be modified."); }
    delete() { throw new Error("ReadonlyURLSearchParams cannot be modified."); }
    set() { throw new Error("ReadonlyURLSearchParams cannot be modified."); }
    sort() { throw new Error("ReadonlyURLSearchParams cannot be modified."); }
  }
  const navigationModule = Object.freeze({
    usePathname() { return useUrl().pathname; },
    useSearchParams() {
      const search = useUrl().search;
      return React.useMemo(() => new ReadonlySearchParams(search), [search]);
    },
    useParams() {
      return React.useContext(ParamsContext);
    },
    useSelectedLayoutSegments(parallelRouteKey = "children") {
      return React.useContext(LayoutContext).segments[parallelRouteKey] || [];
    },
    useSelectedLayoutSegment(parallelRouteKey = "children") {
      const segments = navigationModule.useSelectedLayoutSegments(parallelRouteKey);
      const segment = parallelRouteKey === "children" ? segments[0] : segments[segments.length - 1];
      return segment === "__DEFAULT__" ? null : segment ?? null;
    },
    useRouter() {
      return React.useMemo(() => ({
        back: () => navigate("back"),
        forward: () => navigate("forward"),
        prefetch: async () => {},
        push: (href, options) => navigate("push", href, options),
        replace: (href, options) => navigate("replace", href, options),
        refresh: () => navigate("refresh"),
      }), []);
    },
  });
  return { BranchCache, LayoutScope, PageScope, RouterRoot, navigate, navigationModule, setUrl };
};
