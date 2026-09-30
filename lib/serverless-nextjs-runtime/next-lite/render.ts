import { pathToFileURL } from "node:url";
import type { NextLiteBuildArtifact } from "./compiler";

export type NextLiteRenderer = {
  renderNextLiteRequest(request: Request): Promise<Response>;
};

export async function loadNextLiteRenderer(
  artifact: NextLiteBuildArtifact,
): Promise<NextLiteRenderer> {
  const moduleUrl = `${pathToFileURL(artifact.entryFile).href}?t=${Date.now()}`;
  const rendererModule = (await import(/* webpackIgnore: true */ moduleUrl)) as Partial<NextLiteRenderer>;

  if (typeof rendererModule.renderNextLiteRequest !== "function") {
    throw new Error("next-lite artifact does not export renderNextLiteRequest().");
  }

  return {
    renderNextLiteRequest: rendererModule.renderNextLiteRequest,
  };
}
