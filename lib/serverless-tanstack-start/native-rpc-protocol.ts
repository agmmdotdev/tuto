export type NativeRpcRequest = {
  bodyBase64?: string;
  headers: Array<[string, string]>;
  method: string;
  serverFnId?: string;
  url: string;
};

export type NativeRpcResult = {
  bodyBase64: string;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

export type NativeWorkerCommand =
  | {
      artifact: {
        kernelId: string;
        revision: string;
        serverBundle: string;
      };
      maxResponseBytes: number;
      type: "initialize";
    }
  | {
      id: string;
      request: NativeRpcRequest;
      type: "execute";
    }
  | {
      type: "shutdown";
    };

export type NativeWorkerMessage =
  | {
      pid: number;
      revision: string;
      type: "ready";
    }
  | {
      error: {
        message: string;
        name: string;
        stack?: string;
      };
      fatal?: boolean;
      id?: string;
      type: "error";
    }
  | {
      id: string;
      result: NativeRpcResult;
      type: "result";
    };
