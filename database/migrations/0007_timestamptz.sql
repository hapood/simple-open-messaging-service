-- Absolute instants must not depend on the database server or client session timezone. This is a
-- schema-only conversion; deployments with disposable pre-release data should recreate the database.
DO $$
DECLARE
  column_row record;
BEGIN
  FOR column_row IN
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND data_type = 'timestamp without time zone'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamptz(3) USING %I AT TIME ZONE ''UTC''',
      column_row.table_schema,
      column_row.table_name,
      column_row.column_name,
      column_row.column_name
    );
  END LOOP;
END
$$;
