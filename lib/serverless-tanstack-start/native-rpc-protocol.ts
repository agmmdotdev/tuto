export type NativeRpcRequest = {
  bodyBase64?: string;
  headers: Array<[string, string]>;
  method: string;
  serverFnId?: string;
  streamResponse?: boolean;
  url: string;
};

export type NativeRpcResponseHead = {
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

export type NativeRpcResult = NativeRpcResponseHead & {
  bodyBase64: string;
};

export type NativeWorkerCommand =
  | {
      runtime: {
        entryHash: string;
        entryPath: string;
        kernelId: string;
        revision: string;
      };
      maxResponseBytes: number;
      rscActionEncryptionKey: string;
      type: "initialize";
    }
  | {
      id: string;
      request: NativeRpcRequest;
      type: "execute";
    }
  | {
      id: string;
      type: "cancel";
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
    }
  | {
      id: string;
      response: NativeRpcResponseHead;
      type: "stream-start";
    }
  | {
      bodyBase64: string;
      id: string;
      type: "stream-chunk";
    }
  | {
      id: string;
      type: "stream-end";
    };
