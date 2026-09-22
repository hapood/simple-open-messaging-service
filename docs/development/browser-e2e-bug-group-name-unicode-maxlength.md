# BUG: Group Name Maxlength Counts UTF-16 Units Instead of User Characters

## Status

FIXED and verified in the browser lab on 2026-09-22.

## Reproduction

1. Open the Web client on the Bravo edge and open **New group**.
2. Fill the group name with 31 emoji characters, for example
   `😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀`.
3. Observe the name field and counter.

Observed result before the fix:

```json
{
  "requestedCodePoints": 31,
  "acceptedCodePoints": 15,
  "acceptedUtf16Length": 30,
  "counter": "30 / 31",
  "createEnabled": true
}
```

The browser's native `maxlength="31"` counts UTF-16 code units. Each emoji
uses two units, so the user cannot enter the server-supported 31-character
name. The backend's group validation correctly counts Unicode code points with
`[name].length` and accepts up to 31 user characters, so this is a client-side
input defect rather than a backend validation discrepancy.

The same native `maxlength="31"` exists in the group metadata editor, and its
direct `ngModelChange` assignment has the same risk.

## Root cause and solution

Use one code-point-aware group-name normalization rule in the Web client:

```ts
function limitGroupName(value: string): string {
  return [...value].slice(0, 31).join('');
}
```

The Web client now applies this rule in both the new-group and group-info editor
input handlers, removes the native UTF-16 `maxlength` attributes, and renders
code-point counters. The server DTO and domain validation are unchanged because
they already enforce the intended Unicode boundary.

Verification:

- New-group component tests: 2/2 passed, including 31 emoji and 240 emoji
  description limits.
- Unicode helper tests: 2/2 passed, including surrogate-pair and combining-mark
  boundaries.
- `npm run build:development`: passed.
- Browser retest: 31 emoji accepted, counter shows `31 / 31`, group creation
  succeeds, and the temporary group was dissolved afterward.

## Evidence

- Temporary reproduction: `scripts/.tmp-new-group-unicode-boundary.mjs`
- Bravo browser profile: `scenario-charlie`
- Browser edge: `http://localhost:3102/`
- No group was created by the reproduction; the dialog remained open.
