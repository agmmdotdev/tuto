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
  const Link = React.forwardRef(function Link(
    { children, href, onClick, onMouseEnter, onTouchStart, replace = false, scroll = true, prefetch, target, ...props }, ref,
  ) {
    const value = href instanceof URL ? href.href : String(href);
    function prefetchIntent(event) {
      if (prefetch === false || event.currentTarget.hasAttribute("download") || (target && target !== "_self")) return;
      const previous = new URL(currentUrl(), "http://next.local");
      const next = new URL(value, previous);
      if (next.origin !== previous.origin || (next.pathname === previous.pathname && next.search === previous.search)) return;
      globalThis.__TUTO_NEXT_PREFETCH__?.(value, { _prefetchMode: prefetch === true ? "full" : "auto" });
    }
    return React.createElement("a", {
      ...props, href: value, target, ref,
      onMouseEnter(event) { onMouseEnter?.(event); prefetchIntent(event); },
      onTouchStart(event) { onTouchStart?.(event); prefetchIntent(event); },
      onClick(event) {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
            event.currentTarget.hasAttribute("download") || (target && target !== "_self")) return;
        if (navigate(replace ? "replace" : "push", value, { scroll })) event.preventDefault();
      },
    }, children);
  });
  function RouterRoot({ state, params, children, provisional = false }) {
    React.useEffect(() => {
      if (!provisional) globalThis.__TUTO_NEXT_ROUTER_STATE__ = state;
      globalThis.__TUTO_NEXT_NAVIGATION_COMMIT__?.(state?.navigationId);
    }, [state, provisional]);
    return React.createElement(ParamsContext.Provider, { value: params }, children);
  }
  function LayoutScope({ value, children }) {
    return React.createElement(LayoutContext.Provider, { value }, children);
  }
  function PageScope({ params, children }) {
    return React.createElement(LayoutContext.Provider, { value: {params, segments: {}} }, children);
  }
  function BranchCache({ branchKey, children, deferred = false }) {
    const [cache, setCache] = React.useState(() => ({
      key: branchKey, child: children, entries: new Map([[branchKey, children]]),
    }));
    let entries = cache.entries;
    // A provisional shell leaves already mounted deferred branches intact.
    if (deferred && entries.has(branchKey)) children = entries.get(branchKey);
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
  class NavigationRedirectBoundary extends React.Component {
    constructor(props) { super(props); this.state = {error:null, resetKey:props.resetKey}; }
    static getDerivedStateFromProps(props, state) {
      return props.resetKey !== state.resetKey ? {error:null, resetKey:props.resetKey} : null;
    }
    static getDerivedStateFromError(error) { return {error}; }
    componentDidCatch(error) {
      const parts = typeof error?.digest === "string" ? error.digest.split(";") : [];
      if (parts[0] !== "NEXT_REDIRECT") return;
      const kind = parts[1] === "push" ? "push" : "replace";
      navigate(kind, parts.slice(2, -2).join(";"));
    }
    render() {
      if (!this.state.error) return this.props.children;
      if (this.state.error?.digest?.startsWith("NEXT_REDIRECT;")) return null;
      throw this.state.error;
    }
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
        prefetch: (href, options) => globalThis.__TUTO_NEXT_PREFETCH__?.(href, options),
        push: (href, options) => navigate("push", href, options),
        replace: (href, options) => navigate("replace", href, options),
        refresh: () => navigate("refresh"),
      }), []);
    },
  });
  return { Link, NavigationRedirectBoundary, BranchCache, LayoutScope, PageScope, RouterRoot, navigate, navigationModule, setUrl };
};
