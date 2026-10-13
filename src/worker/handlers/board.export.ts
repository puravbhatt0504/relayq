import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Handler } from "./types.js";
import { signedPost } from "./webhook.deliver.js";

type Board = { id: string; title: string; columns: { title: string; cards: { id: string; title: string }[] }[] };

const s3 = new S3Client({});
const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export const toCsv = (b: Board) =>
  ["column,card_id,card_title", ...b.columns.flatMap((c) => c.cards.map((k) => [c.title, k.id, k.title].map(cell).join(",")))].join("\n");

// Fetch + upload are safe to repeat (the S3 key is per job, so a re-run overwrites); the callback is once().
export const boardExport: Handler<"board.export"> = async ({ boardId, format, callbackUrl }, { jobId, once }) => {
  const res = await fetch(`${process.env.PULSEBOARD_URL}/boards/${encodeURIComponent(boardId)}`, {
    headers: { authorization: `Bearer ${process.env.PULSEBOARD_TOKEN ?? ""}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`fetch board ${boardId} → ${res.status}`);
  const board = (await res.json()) as Board;

  const Body = format === "json" ? JSON.stringify(board) : toCsv(board);
  const ContentType = format === "json" ? "application/json" : "text/csv";
  const Bucket = process.env.EXPORT_BUCKET;
  // ponytail: no bucket (free demo) → file goes inline in the callback; fine for board-sized files, set EXPORT_BUCKET for big ones.
  if (!Bucket) {
    const url = `data:${ContentType};base64,${Buffer.from(Body).toString("base64")}`;
    return once("callback", async () => {
      await signedPost(callbackUrl, { jobId, url }, `${jobId}:callback`);
      return { inline: true, bytes: Buffer.byteLength(Body) };
    });
  }
  const Key = `exports/${boardId}/${jobId}.${format}`;
  await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
  // ponytail: presigned URL dies with the signing credentials (hours on an ECS task role); proxy downloads if users need longer links.
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 7 * 86400 });
  return once("callback", async () => {
    await signedPost(callbackUrl, { jobId, url }, `${jobId}:callback`);
    return { key: Key, url };
  });
};
