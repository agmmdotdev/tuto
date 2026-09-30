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
  kind: "push" | "replace" | "refresh" | "restore";
  state?: NextRouterState;
};
