export async function ensureLabDatabase(client, database) {
  const result = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [database],
  );
  if (result.rows.length) return false;

  const identifier = `"${database.replaceAll('"', '""')}"`;
  await client.query(`CREATE DATABASE ${identifier}`);
  return true;
}
