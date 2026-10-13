import { expect, it } from "vitest";
import { toCsv } from "../src/worker/handlers/board.export.js";
import { renderDigest } from "../src/worker/handlers/email.digest.js";

it("renderDigest escapes HTML and drops non-http links", () => {
  const html = renderDigest("<b>Ann</b>", [
    { title: 'Card "1" & <script>', url: "https://pb.app/c/1?a=1&b=2" },
    { title: "evil", url: "javascript:alert(1)" },
  ]);
  expect(html).toContain("Hi &#60;b&#62;Ann&#60;/b&#62;");
  expect(html).toContain('<a href="https://pb.app/c/1?a=1&#38;b=2">Card &#34;1&#34; &#38; &#60;script&#62;</a>');
  expect(html).toContain("<li>evil</li>");
  expect(html).not.toContain("javascript:");
});

it("toCsv quotes commas, quotes and newlines", () => {
  const csv = toCsv({
    id: "b1", title: "B",
    columns: [{ title: "To do, now", cards: [{ id: "c1", title: 'say "hi"\nthere' }, { id: "c2", title: "plain" }] }],
  });
  expect(csv).toBe('column,card_id,card_title\n"To do, now",c1,"say ""hi""\nthere"\n"To do, now",c2,plain');
});

it("board.export without EXPORT_BUCKET posts the file inline as a data: URL", async () => {
  const { createServer } = await import("node:http");
  const { boardExport } = await import("../src/worker/handlers/board.export.js");
  let callback: { jobId: string; url: string } | undefined;
  const srv = createServer((req, res) => {
    if (req.url === "/boards/b1") return res.end(JSON.stringify({ id: "b1", title: "B", columns: [{ title: "Todo", cards: [{ id: "c1", title: "x" }] }] }));
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => { callback = JSON.parse(raw); res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as { port: number }).port}`;
  const saved = { ...process.env };
  Object.assign(process.env, { PULSEBOARD_URL: base, WEBHOOK_SECRET: "s" });
  delete process.env.EXPORT_BUCKET;
  try {
    const once = (async (_s: string, fn: () => Promise<unknown>) => fn()) as never;
    await boardExport({ boardId: "b1", format: "csv", callbackUrl: `${base}/cb` }, { jobId: "j1", tenant: "t", once } as never);
  } finally {
    process.env = saved;
    srv.close();
  }
  expect(callback?.jobId).toBe("j1");
  expect(callback?.url).toBe(`data:text/csv;base64,${Buffer.from("column,card_id,card_title\nTodo,c1,x").toString("base64")}`);
});
