ALTER TABLE "SceneContinuationDraft" DROP COLUMN "skillId";
ALTER TABLE "SceneContinuationDraft" ADD COLUMN "promptSnapshotJson" TEXT;
ALTER TABLE "CodexSession" ADD COLUMN "continuationPanelId" TEXT;
