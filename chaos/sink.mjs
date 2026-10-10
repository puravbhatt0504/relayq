// Webhook sink for the chaos run: counts deliveries and distinct Idempotency-Keys.
import { createServer } from "node:http";

let deliveries = 0;
const keys = new Set();

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ deliveries, distinct: keys.size }));
  }
  if (req.method === "POST" && req.url === "/reset") {
    deliveries = 0;
    keys.clear();
    return res.end("ok");
  }
  req.resume().on("end", () => {
    deliveries++;
    const key = req.headers["idempotency-key"];
    if (key) keys.add(key);
    res.end("ok");
  });
}).listen(5679);
