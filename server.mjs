import { createServer } from "node:http";

const { default: startHandler } = await import("./dist/server/server.js");
const { attachWebSocketHandler } = await import("./dist/ws.mjs");

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const response = await startHandler.fetch(
    new Request(url, { method: req.method, headers, body })
  );

  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.setHeader(k, v);

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

const server = createServer((req, res) =>
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  })
);

attachWebSocketHandler(server);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () =>
  console.log(`Server listening on http://0.0.0.0:${port}`)
);
