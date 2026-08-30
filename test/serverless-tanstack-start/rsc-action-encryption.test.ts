import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import kernelManifest from "../../lib/serverless-tanstack-start/kernel-manifest.generated.json";
import {
  getRscActionEncryptionKey,
  validateRscActionEncryptionKey,
} from "../../lib/serverless-tanstack-start/rsc-action-encryption";

type RscActionEncryptionModule = {
  decryptActionBoundArgs(value: Promise<string> | string): Promise<unknown>;
  encryptActionBoundArgs(value: unknown): Promise<string>;
};

type KernelGlobals = typeof globalThis & Record<string, unknown>;

test("validates configured RSC action encryption keys", () => {
  const validKey = Buffer.alloc(32, 23).toString("base64");

  assert.equal(validateRscActionEncryptionKey(validKey), validKey);
  assert.equal(getRscActionEncryptionKey(validKey), validKey);
  assert.throws(
    () => validateRscActionEncryptionKey("not-a-deployment-key"),
    /base64-encoded 32-byte key/i,
  );
});

test("the shared RSC kernel encrypts bound arguments and rejects tampering", async () => {
  const globals = globalThis as KernelGlobals;
  const priorServerKernel = globals[kernelManifest.server.globalKey];
  const priorRscKernel = globals[kernelManifest.rsc.globalKey];
  const priorEncryptionKey =
    globals[kernelManifest.rsc.actionEncryptionKeyGlobalKey];
  const correctKey = Buffer.alloc(32, 29).toString("base64");
  const incorrectKey = Buffer.alloc(32, 31).toString("base64");
  const serverModules = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@tanstack/start-storage-context"),
  ]);

  globals[kernelManifest.server.globalKey] = {
    modules: {
      "@tanstack/react-start/server": serverModules[0],
      "@tanstack/start-storage-context": serverModules[1],
    },
  };

  try {
    globals[kernelManifest.rsc.actionEncryptionKeyGlobalKey] = correctKey;
    const kernelUrl = pathToFileURL(
      path.resolve(
        process.cwd(),
        "lib",
        "serverless-tanstack-start",
        kernelManifest.rsc.file,
      ),
    ).href;
    await import(/* @vite-ignore */ `${kernelUrl}?test=${randomUUID()}`);
    const encryption = (
      globals[kernelManifest.rsc.globalKey] as {
        modules: Record<string, unknown>;
      }
    ).modules[
      "@vitejs/plugin-rsc/utils/encryption-runtime"
    ] as RscActionEncryptionModule;
    const boundValue = {
      nested: ["deployment-only-bound-value", 42],
      role: "server-action-closure",
    };
    const encrypted = await encryption.encryptActionBoundArgs(boundValue);

    assert.notEqual(encrypted, JSON.stringify(boundValue));
    assert.doesNotMatch(encrypted, /deployment-only-bound-value/);
    assert.deepEqual(
      await encryption.decryptActionBoundArgs(encrypted),
      boundValue,
    );

    const tamperedBytes = Buffer.from(encrypted, "base64");
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    await assert.rejects(
      encryption.decryptActionBoundArgs(tamperedBytes.toString("base64")),
    );

    globals[kernelManifest.rsc.actionEncryptionKeyGlobalKey] = incorrectKey;
    await import(/* @vite-ignore */ `${kernelUrl}?wrong-key=${randomUUID()}`);
    const wrongKeyEncryption = (
      globals[kernelManifest.rsc.globalKey] as {
        modules: Record<string, unknown>;
      }
    ).modules[
      "@vitejs/plugin-rsc/utils/encryption-runtime"
    ] as RscActionEncryptionModule;
    await assert.rejects(
      wrongKeyEncryption.decryptActionBoundArgs(encrypted),
    );
  } finally {
    if (priorServerKernel === undefined)
      delete globals[kernelManifest.server.globalKey];
    else globals[kernelManifest.server.globalKey] = priorServerKernel;
    if (priorRscKernel === undefined)
      delete globals[kernelManifest.rsc.globalKey];
    else globals[kernelManifest.rsc.globalKey] = priorRscKernel;
    if (priorEncryptionKey === undefined)
      delete globals[kernelManifest.rsc.actionEncryptionKeyGlobalKey];
    else
      globals[kernelManifest.rsc.actionEncryptionKeyGlobalKey] =
        priorEncryptionKey;
  }
});

