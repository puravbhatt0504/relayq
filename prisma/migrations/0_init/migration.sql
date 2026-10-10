-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ApiKey" (
    "hash" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "JobRecord" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobRecord_tenant_status_idx" ON "JobRecord"("tenant", "status");

