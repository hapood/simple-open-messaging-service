# BUG: Personal Profile Limits Count UTF-16 Units Instead of User Characters

## Status

FIXED and browser-verified on 2026-09-22.

## Reproduction

1. Open the Web client on the Bravo edge.
2. Open **Edit personal profile**.
3. Fill the nickname with 31 emoji and the bio with 120 emoji.

Observed result:

```json
{
  "nicknameRequestedCodePoints": 31,
  "nicknameAcceptedCodePoints": 15,
  "nicknameAcceptedUtf16Length": 30,
  "bioRequestedCodePoints": 120,
  "bioAcceptedCodePoints": 60,
  "bioAcceptedUtf16Length": 120,
  "bioCounter": "120/120"
}
```

The native `maxlength="31"` and `maxlength="120"` attributes count UTF-16
code units. The nickname therefore stops at 15 emoji, while the bio stops at
60 emoji even though both are within the server's intended character limits.
The nickname validation in `ProfileEditorComponent` also uses
`name.length`, so it shares the same unit mismatch.

## Root cause and solution

Reuse the code-point helpers added for the fixed group-name bug:

```ts
const name = limitUnicodeCodePoints(value, 31);
const bio = limitUnicodeCodePoints(value, 120);
```

The profile editor now applies them in the name and bio input handlers, removes
the native maxlength attributes, and uses `unicodeCodePointLength` for name
validation and the bio counter. The backend DTO is unchanged.

Verification:

- Profile editor component test passed for 31 nickname emoji and 120 bio emoji.
- Unicode helper tests: 2/2 passed.
- Focused regression set: 20 tests passed across 5 files.
- `npm run build:development`: passed.
- Rebuilt-browser verification passed: the editor accepted 31 nickname emoji
  and 120 bio emoji, and the bio counter showed `120/120`.

## Evidence

- Temporary reproduction: `scripts/.tmp-profile-unicode-boundary.mjs`
- Browser profile: `scenario-charlie`
- Browser edge: `http://localhost:3102/`
- No profile save was submitted; the edited values remained local draft state.
