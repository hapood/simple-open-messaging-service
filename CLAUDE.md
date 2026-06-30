# CLAUDE.md

Project-level guidance for Claude working in this repository. **These instructions override default behavior and MUST be followed exactly.**

## Guiding Principle

- **Every technical decision must follow the best practice for that scenario, with no regard for development cost.**
  - Never trade correctness, security, maintainability, or architectural cleanliness for "faster delivery," "fewer changes," or "lower regression risk."
  - When multiple implementation paths exist, select and execute the recognized best option directly — do not ship a suboptimal solution first and wait to be challenged. Extra effort is not a decision factor.
  - Scope clarification: this means "choose by best practice," not "rewrite everything by default." If the best practice is the minimal change, do that; if it requires more work, do that.
