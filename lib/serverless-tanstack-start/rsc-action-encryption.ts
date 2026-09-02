import { randomBytes } from "node:crypto";

const actionEncryptionKeyEnvironment =
  "TUTO_TANSTACK_RSC_ACTION_ENCRYPTION_KEY";
const processKeySymbol = Symbol.for(
  "tuto.tanstack-start.rsc-action-encryption-key.v1",
);

type EncryptionKeyGlobals = typeof globalThis & {
  [processKeySymbol]?: string;
};

export function validateRscActionEncryptionKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(
      `${actionEncryptionKeyEnvironment} must be a base64-encoded 32-byte key.`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error(
      `${actionEncryptionKeyEnvironment} must be a base64-encoded 32-byte key.`,
    );
  }
  return value;
}

export function getRscActionEncryptionKey(
  configuredKey = process.env[actionEncryptionKeyEnvironment],
) {
  if (configuredKey !== undefined) {
    return validateRscActionEncryptionKey(configuredKey);
  }

  const globals = globalThis as EncryptionKeyGlobals;
  globals[processKeySymbol] ??= randomBytes(32).toString("base64");
  return globals[processKeySymbol];
}

