-- AlterTable
ALTER TABLE "JobRecord" ADD COLUMN     "idempotencyKey" TEXT,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- CreateTable
CREATE TABLE "Outbox" (
    "id" BIGSERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "delayMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EffectLog" (
    "jobId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EffectLog_pkey" PRIMARY KEY ("jobId","step")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_jobId_key" ON "Outbox"("jobId");

-- CreateIndex
CREATE INDEX "Outbox_publishedAt_id_idx" ON "Outbox"("publishedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "JobRecord_tenant_idempotencyKey_key" ON "JobRecord"("tenant", "idempotencyKey");

