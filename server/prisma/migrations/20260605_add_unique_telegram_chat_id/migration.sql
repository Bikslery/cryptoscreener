-- DropIndex
-- (no existing index to drop)

-- CreateIndex
-- First, clean up duplicates: keep the earliest user per chatId, delete the rest
DELETE FROM "User"
WHERE id IN (
  SELECT u.id
  FROM "User" u
  INNER JOIN (
    SELECT "telegramChatId", MIN("createdAt") as first_created
    FROM "User"
    WHERE "telegramChatId" IS NOT NULL
    GROUP BY "telegramChatId"
    HAVING COUNT(*) > 1
  ) dup ON u."telegramChatId" = dup."telegramChatId"
  AND u."createdAt" > dup.first_created
);

-- Now add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramChatId_key" ON "User"("telegramChatId");
