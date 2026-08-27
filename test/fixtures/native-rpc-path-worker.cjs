const builtins = Promise.all([import("node:fs/promises"), import("node:path")]);

let initialization;

process.on("message", async (message) => {
  if (message.type === "initialize") {
    const [{ readFile }, { isAbsolute }] = await builtins;
    const serialized = JSON.stringify(message);
    const entrySource = await readFile(message.runtime.entryPath, "utf8");
    initialization = {
      entryContainsSource: entrySource.includes("ipc-secret-source"),
      entryPathIsAbsolute: isAbsolute(message.runtime.entryPath),
      initializeBytesUnderOneKilobyte: Buffer.byteLength(serialized) < 1_024,
      sourceCrossedIpc: serialized.includes("ipc-secret-source"),
    };
    process.send({
      pid: process.pid,
      revision: message.runtime.revision,
      type: "ready",
    });
  }

  if (message.type === "execute") {
    process.send({
      id: message.id,
      result: {
        bodyBase64: Buffer.from(JSON.stringify(initialization)).toString(
          "base64",
        ),
        headers: [["content-type", "application/json"]],
        status: 200,
        statusText: "OK",
      },
      type: "result",
    });
  }

  if (message.type === "shutdown") process.disconnect();
});
