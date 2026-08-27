import { executeNativeArtifactRequest } from "../../../../../lib/serverless-tanstack-start/native-request-host";

export const runtime = "nodejs";

function handle(request: Request) {
  return executeNativeArtifactRequest(request);
}

export const DELETE = handle;
export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const PATCH = handle;
export const POST = handle;
export const PUT = handle;
