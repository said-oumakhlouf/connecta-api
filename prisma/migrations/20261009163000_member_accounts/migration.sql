CREATE TABLE "Member" (
 "id" TEXT NOT NULL, "email" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Member_email_key" ON "Member"("email");
CREATE TABLE "MemberSession" (
 "tokenHash" TEXT NOT NULL, "memberId" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MemberSession_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "MemberSession_memberId_idx" ON "MemberSession"("memberId");
CREATE INDEX "MemberSession_expiresAt_idx" ON "MemberSession"("expiresAt");
ALTER TABLE "MemberSession" ADD CONSTRAINT "MemberSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "MemberLoginToken" (
 "tokenHash" TEXT NOT NULL, "email" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MemberLoginToken_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "MemberLoginToken_email_createdAt_idx" ON "MemberLoginToken"("email", "createdAt");
CREATE INDEX "MemberLoginToken_expiresAt_idx" ON "MemberLoginToken"("expiresAt");
