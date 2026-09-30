-- CreateTable
CREATE TABLE "InsightFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "insightKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "InsightFeedback_insightKey_key" ON "InsightFeedback"("insightKey");

-- CreateIndex
CREATE INDEX "InsightFeedback_kind_verdict_idx" ON "InsightFeedback"("kind", "verdict");
