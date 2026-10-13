import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Handler } from "./types.js";
import { signedPost } from "./webhook.deliver.js";

/**
 * Trainer contract (PulseBoard's ml/<name> image implements it): gets DATA_URL and MODEL_NAME,
 * trains, uploads the model itself, and prints one JSON line last on stdout:
 *   {"s3Uri": "s3://bucket/models/eta/2026-10-13/", "metrics": {"mae": 5.2, ...}}
 * Lower test MAE is better. Exit non-zero = crash (the job retries with backoff).
 */
const trainerOutput = z.object({
  s3Uri: z.string().min(1),
  metrics: z.object({ mae: z.number().nonnegative() }).catchall(z.number()),
});
export type TrainerOutput = z.infer<typeof trainerOutput>;
export type Trainer = (modelName: string, dataUrl: string) => Promise<TrainerOutput>;

const envName = (name: string) => name.toUpperCase().replace(/-/g, "_");

// ponytail: local `docker run` only (the worker needs a Docker socket); ECS RunTask when retrains must run in AWS.
export const dockerTrainer: Trainer = async (name, dataUrl) => {
  const image = process.env[`TRAINER_IMAGE_${envName(name)}`] ?? `pulseboard-ml-${name}`;
  // Without a bucket the trainer writes file:///models/...; mount a host dir there so the model outlives `--rm`.
  const modelDir = process.env.TRAINER_MODEL_DIR;
  const { stdout } = await promisify(execFile)(
    "docker", ["run", "--rm", ...(modelDir ? ["-v", `${modelDir}:/models`] : []), "-e", `DATA_URL=${dataUrl}`, "-e", `MODEL_NAME=${name}`, image],
    { timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return trainerOutput.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
};

/** Subscribers to notify on promotion: MODEL_SUBSCRIBERS_<NAME>=url1,url2 */
const subscribers = (name: string) =>
  (process.env[`MODEL_SUBSCRIBERS_${envName(name)}`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Training is safe to repeat (a crash before "register" just trains again); registration + promotion is one
// transaction recorded by once(), so a re-delivery can't register twice or leave two versions promoted.
export const mlRetrain = (train: Trainer = dockerTrainer): Handler<"ml.retrain"> => async ({ modelName: name, dataUrl }, { jobId, once }) => {
  const out = trainerOutput.parse(await train(name, dataUrl));

  const reg = await once("register", async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`; // one registration per model at a time
    const current = await tx.modelVersion.findFirst({ where: { name, status: "promoted" } });
    const { _max } = await tx.modelVersion.aggregate({ where: { name }, _max: { version: true } });
    const version = (_max.version ?? 0) + 1;
    const currentMae = current && (current.metrics as { mae: number }).mae;
    const promote = current == null || out.metrics.mae <= currentMae!;
    if (promote && current) await tx.modelVersion.update({ where: { id: current.id }, data: { status: "retired" } });
    const reason = promote ? null : `test MAE ${out.metrics.mae} > promoted v${current!.version} MAE ${currentMae}`;
    const status = promote ? "promoted" : "rejected";
    await tx.modelVersion.create({ data: { name, version, s3Uri: out.s3Uri, metrics: out.metrics, status, reason, jobId } });
    return { version, status, reason };
  });

  if (reg.status === "promoted") {
    for (const [i, url] of subscribers(name).entries()) {
      await once(`notify:${i}`, () => signedPost(url, { name, version: reg.version }, `${jobId}:notify:${i}`));
    }
  }
  return { name, ...reg, metrics: out.metrics };
};
