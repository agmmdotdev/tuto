export type NextRouterBranch = {
  page: string;
  url: string;
  intercepted?: boolean;
};

export type NextRouterState = {
  navigationId?: string;
  version: 1;
  revision: string;
  url: string;
  primary: NextRouterBranch;
  slots: Record<string, NextRouterBranch>;
};

export type NextNavigationRequest = {
  id?: string;
  // Internal renderer hints: the HTTP API overwrites these after receipt validation.
  segmentContext?: string;
  reuseSegments?: Array<{key:string;slots:string[]}>;
  kind: "push" | "replace" | "refresh" | "restore";
  state?: NextRouterState;
};
