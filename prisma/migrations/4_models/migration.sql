CREATE TABLE "ModelVersion" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "s3Uri" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ModelVersion_status_check" CHECK ("status" IN ('candidate', 'promoted', 'rejected', 'retired'))
);
CREATE UNIQUE INDEX "ModelVersion_name_version_key" ON "ModelVersion"("name", "version");
-- Exactly one promoted version per model name, enforced by the database.
CREATE UNIQUE INDEX "ModelVersion_one_promoted" ON "ModelVersion"("name") WHERE "status" = 'promoted';
