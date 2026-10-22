/**
 * Shared, stable topology for the interactive federation lab and its external workload runners.
 * Keeping this in one module prevents a runner from silently targeting different domains, ports,
 * or databases than the UI-facing lab.
 */
function configuredDatabasePrefix() {
  const prefix = process.env.FED_LAB_DATABASE_PREFIX?.trim();
  if (!prefix) return 'soms_fed_lab';
  if (!/^[a-z][a-z0-9_]{0,49}$/.test(prefix))
    throw new Error(
      'FED_LAB_DATABASE_PREFIX must start with a letter and contain at most 50 lowercase letters, digits, or underscores',
    );
  return prefix;
}

function configuredBackendPorts() {
  const raw = process.env.FED_LAB_BACKEND_PORTS;
  if (!raw) return [3201, 3202, 3203];
  let ports;
  try {
    ports = JSON.parse(raw);
  } catch {
    throw new Error('FED_LAB_BACKEND_PORTS must be a JSON array');
  }
  if (
    !Array.isArray(ports) ||
    ports.length !== 3 ||
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
  )
    throw new Error(
      'FED_LAB_BACKEND_PORTS must contain exactly three valid TCP ports',
    );
  if (new Set(ports).size !== ports.length)
    throw new Error('FED_LAB_BACKEND_PORTS must contain unique TCP ports');
  return ports;
}

const backendPorts = configuredBackendPorts();
const databasePrefix = configuredDatabasePrefix();

export const federationLabNodes = Object.freeze(
  [
    {
      name: 'alpha',
      domain: 'alpha.test',
      edgePort: 3101,
      backendPort: backendPorts[0],
    },
    {
      name: 'bravo',
      domain: 'bravo.test',
      edgePort: 3102,
      backendPort: backendPorts[1],
    },
    {
      name: 'charlie',
      domain: 'charlie.test',
      edgePort: 3103,
      backendPort: backendPorts[2],
    },
  ].map((node) =>
    Object.freeze({
      ...node,
      transitionDomain: `${node.name}-transition.test`,
      database: `${databasePrefix}_${node.name}`,
      backendBaseUrl: `http://127.0.0.1:${node.backendPort}`,
      browserBaseUrl: `http://localhost:${node.edgePort}`,
    }),
  ),
);

export const federationLabRoutes = Object.freeze(
  Object.fromEntries(
    federationLabNodes.flatMap((node) => [
      [node.domain, node.backendBaseUrl],
      [node.transitionDomain, node.backendBaseUrl],
    ]),
  ),
);

export function federationLabDatabaseUrl(baseDatabaseUrl, database) {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function federationLabNodeForDomain(domain) {
  const node = federationLabNodes.find(
    (candidate) =>
      candidate.domain === domain || candidate.transitionDomain === domain,
  );
  if (!node) throw new Error(`unknown federation lab domain: ${domain}`);
  return node;
}

export function federationLabNode(name) {
  const node = federationLabNodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`unknown federation lab node: ${name}`);
  return node;
}
