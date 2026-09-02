import assert from "node:assert/strict";
import net from "node:net";
import { Wasmer } from "@wasmer/sdk/node";

const serverSource = `
const http = require("node:http");
const port = Number(process.env.PORT);
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("edgejs-ok");
}).listen(port, "0.0.0.0", () => console.log("ready:" + port));
`;

const port = await reservePort();
const wasmer = new Wasmer({
  cache: { directory: new URL("./.wasmer-cache", import.meta.url).pathname },
});
const sandbox = await wasmer.sandboxes.create({
  packages: ["wasmer/edgejs@0.2.0"],
  files: { "server.cjs": serverSource },
  env: { PORT: String(port) },
  network: { mode: "host" },
});
const guest = await sandbox
  .command("edge", ["/workspace/server.cjs"])
  .spawn({ stdout: "pipe", stderr: "capture" });

try {
  await sandbox.ports.wait(port, { timeoutMs: 30_000 });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await response.text(), "edgejs-ok");
  console.log("smoke-ok");
} finally {
  await guest.terminate({ gracePeriodMs: 1_000 });
  await guest.wait();
  await sandbox.close();
  await wasmer.close();
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
