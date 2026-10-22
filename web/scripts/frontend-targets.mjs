export const frontendTargets = Object.freeze({
  web: {
    output: 'dist/web',
    generated: '.generated/web',
    configuration: 'production',
    overlay: 'web-output',
  },
  native: {
    output: 'dist/native',
    generated: '.generated/native',
    configuration: 'production',
    overlay: 'native-output',
  },
  playground: {
    output: 'dist/playground',
    generated: '.generated/playground',
    configuration: 'playground',
    overlay: 'playground-output',
  },
});
export function frontendTarget(name) {
  if (!Object.hasOwn(frontendTargets, name))
    throw new Error(`Unknown frontend build target: ${name}`);
  return frontendTargets[name];
}
