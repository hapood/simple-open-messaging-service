/**
 * Shared, stable topology for the interactive federation lab and its external workload runners.
 * Keeping this in one module prevents a runner from silently targeting different domains, ports,
 * or databases than the UI-facing lab.
 */
export const federationLabNodes = Object.freeze(
  [
    {
      name: 'alpha',
      domain: 'alpha.test',
      edgePort: 3101,
      backendPort: 3201,
    },
    {
      name: 'bravo',
      domain: 'bravo.test',
      edgePort: 3102,
      backendPort: 3202,
    },
    {
      name: 'charlie',
      domain: 'charlie.test',
      edgePort: 3103,
      backendPort: 3203,
    },
  ].map((node) =>
    Object.freeze({
      ...node,
      database: `soms_fed_lab_${node.name}`,
      backendBaseUrl: `http://127.0.0.1:${node.backendPort}`,
      browserBaseUrl: `http://localhost:${node.edgePort}`,
    }),
  ),
);

export const federationLabRoutes = Object.freeze(
  Object.fromEntries(
    federationLabNodes.map((node) => [node.domain, node.backendBaseUrl]),
  ),
);

export function federationLabDatabaseUrl(baseDatabaseUrl, database) {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function federationLabNode(name) {
  const node = federationLabNodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`unknown federation lab node: ${name}`);
  return node;
}
