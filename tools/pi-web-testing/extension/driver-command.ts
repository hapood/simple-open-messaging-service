const LOGIN_ACTIONS = new Set(['adminLogin', 'issueOtp', 'userLogin']);
const FEDERATION_NODES = new Set(['alpha', 'bravo', 'charlie']);

export function assertLoginNode(command: {
  action: string;
  node?: string;
}): void {
  if (
    LOGIN_ACTIONS.has(command.action) &&
    !FEDERATION_NODES.has(command.node ?? '')
  ) {
    throw new Error(
      `${command.action} requires an explicit node: alpha, bravo, or charlie. Use the selected deployment alias; do not infer it from the profile name.`,
    );
  }
}
