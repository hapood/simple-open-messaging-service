-- AddForeignKey
ALTER TABLE "UserMessageThread" ADD CONSTRAINT "UserMessageThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
