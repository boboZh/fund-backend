const express = require("express");
const http = require("node:http");
const router = require("./health");

test("GET /healthz responds over HTTP without database initialization", async () => {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
