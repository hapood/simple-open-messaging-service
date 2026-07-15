-- SessionToken.id: narrow BigInt → Int. The id is now an EXPOSED public value (the device-list revoke
-- target), so it aligns with other exposed ids (User.id is Int). Session volume is bounded by the login
-- rate and will never approach Int's 2.1B ceiling — BigInt was over-cautious inheritance from the
-- token-table convention. No FK references this column (the User↔SessionToken relation is on userId),
-- so the narrowing is safe. Also removes the BigInt/JSON papercut (BigInt throws in JSON.stringify).
ALTER TABLE "SessionToken" ALTER COLUMN id TYPE INTEGER;
