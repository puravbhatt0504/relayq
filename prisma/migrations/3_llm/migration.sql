-- CreateTable
CREATE TABLE "TenantBudget" (
    "tenant" TEXT NOT NULL,
    "monthlyUsdLimit" DECIMAL(12,6) NOT NULL,

    CONSTRAINT "TenantBudget_pkey" PRIMARY KEY ("tenant")
);

-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" BIGSERIAL NOT NULL,
    "jobId" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmUsage_tenant_createdAt_idx" ON "LlmUsage"("tenant", "createdAt");

