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
