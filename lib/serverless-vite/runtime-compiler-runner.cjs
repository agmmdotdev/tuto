/* eslint-disable @typescript-eslint/no-require-imports */
const { compileServerlessWorkspaceRuntime } = require("./runtime-compiler.cjs");

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input || "{}");
    const result = await compileServerlessWorkspaceRuntime(payload.files || []);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
});
