import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Ajv2020Module from 'ajv/dist/2020.js';

const schemaDirectory = fileURLToPath(
  new URL('../../spec/v1/schema/', import.meta.url),
);
const ajv = new Ajv2020Module.default({ strict: false, allErrors: true });
for (const name of readdirSync(schemaDirectory)) {
  if (name.endsWith('.schema.json')) {
    ajv.addSchema(
      JSON.parse(readFileSync(`${schemaDirectory}/${name}`, 'utf8')),
    );
  }
}

/** The envelope schema cannot inspect the JSON encoded inside content. */
export function assertFederationMessageWire(message: {
  contentType: string;
  content: string;
}): void {
  assertFederationWireSchema(
    'urn:somfp:v1:message-query#/$defs/message',
    message,
  );
  assertFederationWireSchema('urn:somfp:v1:message-content', {
    contentType: message.contentType,
    content: JSON.parse(message.content),
  });
}

/** Validate an unmodified producer response, not a reconstructed test fixture. */
export function assertFederationWireSchema(
  schemaId: string,
  value: unknown,
): void {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`unknown federation schema: ${schemaId}`);
  if (!validate(value)) {
    throw new Error(
      `${schemaId}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`,
    );
  }
}
