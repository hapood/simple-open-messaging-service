# SOMFP Changelog

## 1.0.0-draft.1

### Breaking changes

- Public current-profile responses now contain exactly `account`,
  `profileRev`, `profile`, and `proof`. Profile content moves into
  the nested `profile` object; flattened responses are no longer valid.
- Existing local users and live groups without a current profile return
  `profileRev: 0` and `profile: null`, rather than `NOT_FOUND` solely
  because no profile exists. Possession proof remains required.

### Compatibility

- Both peers must support the revised response format.
- Among profile read operations, only the current-profile response allows
  revision 0; exact-revision profile requests still require positive revisions.
  Existing revision-0 references in intents, Group Meta, and messages remain valid.

## 1.0.0-draft.0

Previous Final Review working draft, with flattened positive-revision-only public
current-profile responses.
