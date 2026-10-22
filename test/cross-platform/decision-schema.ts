import type { Decision, TestAction, TestOutcome } from './types.js';

const OUTCOMES = new Set<TestOutcome>([
  'PASS',
  'FAIL',
  'BUG',
  'BLOCKED',
  'SKIPPED',
]);
const KEYS = new Set(['ENTER', 'BACK', 'ESCAPE']);
const DIRECTIONS = new Set(['up', 'down']);
const CONTEXTS = new Set(['webview', 'native']);
const MAX_WAIT_MS = 15_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid AI action: ${field} must be a non-empty string.`);
  }
  return value;
}

function parseAction(value: unknown): TestAction {
  if (!isObject(value))
    throw new Error('Invalid AI decision: action must be an object.');
  const type = requireString(value.type, 'action.type');
  const reason = requireString(value.reason, 'action.reason');

  switch (type) {
    case 'tap':
      return {
        type,
        target: requireString(value.target, 'action.target'),
        reason,
      };
    case 'type':
      return {
        type,
        target: requireString(value.target, 'action.target'),
        text: requireString(value.text, 'action.text'),
        reason,
      };
    case 'press': {
      const key = requireString(value.key, 'action.key');
      if (!KEYS.has(key))
        throw new Error(`Invalid AI action: unsupported key ${key}.`);
      return { type, key: key as 'ENTER' | 'BACK' | 'ESCAPE', reason };
    }
    case 'scroll': {
      const direction = requireString(value.direction, 'action.direction');
      if (!DIRECTIONS.has(direction)) {
        throw new Error(
          `Invalid AI action: unsupported scroll direction ${direction}.`,
        );
      }
      const amount =
        value.amount === undefined ? undefined : Number(value.amount);
      if (
        amount !== undefined &&
        (!Number.isFinite(amount) || amount < 1 || amount > 5_000)
      ) {
        throw new Error(
          'Invalid AI action: scroll amount must be between 1 and 5000.',
        );
      }
      return { type, direction: direction as 'up' | 'down', amount, reason };
    }
    case 'switchContext': {
      const context = requireString(value.context, 'action.context');
      if (!CONTEXTS.has(context)) {
        throw new Error(`Invalid AI action: unsupported context ${context}.`);
      }
      return { type, context: context as 'webview' | 'native', reason };
    }
    case 'wait': {
      const milliseconds = Number(value.milliseconds);
      if (
        !Number.isInteger(milliseconds) ||
        milliseconds < 1 ||
        milliseconds > MAX_WAIT_MS
      ) {
        throw new Error(
          `Invalid AI action: wait milliseconds must be 1-${MAX_WAIT_MS}.`,
        );
      }
      return { type, milliseconds, reason };
    }
    case 'finish': {
      const outcome = requireString(value.outcome, 'action.outcome');
      if (!OUTCOMES.has(outcome as TestOutcome)) {
        throw new Error(`Invalid AI action: unsupported outcome ${outcome}.`);
      }
      return { type, outcome: outcome as TestOutcome, reason };
    }
    default:
      throw new Error(`Invalid AI action: unsupported type ${type}.`);
  }
}

export function parseDecisionText(text: string): Decision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `AI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw new Error('AI decision must be a JSON object.');
  return {
    action: parseAction(parsed.action),
    evidence:
      parsed.evidence === undefined
        ? undefined
        : requireString(parsed.evidence, 'evidence'),
  };
}

export function isFailureOutcome(outcome: TestOutcome): boolean {
  return outcome === 'FAIL' || outcome === 'BUG' || outcome === 'BLOCKED';
}
