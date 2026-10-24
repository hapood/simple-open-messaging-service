import { describe, expect, it } from 'vitest';
import {
  DeploymentPageComponent,
  shellQuote,
} from './deployment-page.component';

// Keep routed components in the Angular unit-test compilation, including
// their external resources. Interaction coverage runs in the browser.
describe('DeploymentPageComponent', () => {
  it('is available to the playground route', () => {
    expect(DeploymentPageComponent).toBeDefined();
  });

  it('quotes custom data directories as one literal shell argument', () => {
    expect(shellQuote('./data')).toBe("'./data'");
    expect(shellQuote('/volume 1/soms data')).toBe("'/volume 1/soms data'");
    expect(shellQuote("a'b/$HOME;$(echo unsafe)")).toBe(
      `'a'"'"'b/$HOME;$(echo unsafe)'`,
    );
  });
});
