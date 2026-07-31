ALTER TABLE "ForwardBundle"
  ADD CONSTRAINT "ForwardBundle_depth_check"
    CHECK ("depth" BETWEEN 1 AND 3),
  ADD CONSTRAINT "ForwardBundle_schema_version_check"
    CHECK ("schemaVersion" = 1),
  ADD CONSTRAINT "ForwardBundle_message_count_check"
    CHECK ("messageCount" BETWEEN 1 AND 100),
  ADD CONSTRAINT "ForwardBundle_asset_count_check"
    CHECK ("assetCount" >= 0),
  ADD CONSTRAINT "ForwardBundle_total_bytes_check"
    CHECK ("totalBytes" >= 0),
  ADD CONSTRAINT "ForwardBundle_manifest_shape_check"
    CHECK (
      jsonb_typeof("manifest") = 'object'
      AND jsonb_typeof("manifest"->'children') = 'array'
      AND jsonb_typeof("manifest"->'messages') = 'array'
      AND ("manifest"->>'schemaVersion')::integer = 1
    );
