import { describe, expect, it } from 'vitest';
import { DeploymentPageComponent } from './deployment-page.component';

// Keep routed components in the Angular unit-test compilation, including
// their external resources. Interaction coverage runs in the browser.
describe('DeploymentPageComponent', () => {
  it('is available to the playground route', () => {
    expect(DeploymentPageComponent).toBeDefined();
  });
});
