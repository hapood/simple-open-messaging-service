-- Drop the user refresh-token family + the User.tokenVersion access-JWT revocation column: user auth is
-- now the single opaque session token (no access JWT, no refresh, no rotation). Admin auth is a separate
-- system (AdminRefreshToken + Admin.tokenVersion) and is untouched. Destructive — historical data not
-- preserved.
ALTER TABLE "User" DROP COLUMN IF EXISTS "tokenVersion";
DROP TABLE IF EXISTS "RefreshToken";
