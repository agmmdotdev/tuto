process.on("message", (message) => {
  if (message.type === "initialize") {
    process.send({
      pid: process.pid,
      revision: message.runtime.revision,
      type: "ready",
    });
  }
  if (message.type === "shutdown") process.disconnect();
});
