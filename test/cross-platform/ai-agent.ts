import { parseDecisionText } from './decision-schema.js';
import type { Decision, NaturalLanguageCase, Observation } from './types.js';

const SYSTEM = `You are an end-to-end UI test agent. Execute a natural-language business test against a live app.
Use only the supplied observation. Choose exactly one safe action. Do not invent selectors, credentials, API calls,
or shell commands. Target values must be visible text, accessibility names, CSS selectors, or Android ids.
Prefer semantic targets. Switch to native only for Android controls such as the native composer or IME.
Finish with outcome PASS only when the exact expectation is visibly satisfied.
Use BUG when the product visibly contradicts expected behavior, FAIL for inconclusive script/action failure,
BLOCKED when environment or platform support is missing, and SKIPPED when the case is explicitly not applicable.
Return JSON only: {"action": {"type": ..., ...}, "evidence": "..."}.`;

export class AiAgent {
  constructor(
    private readonly endpoint = process.env.AI_TEST_ENDPOINT ??
      'https://api.openai.com/v1/responses',
    private readonly model = process.env.AI_TEST_MODEL ?? 'gpt-4.1-mini',
    private readonly apiKey = process.env.AI_TEST_API_KEY,
  ) {}

  async decide(
    testCase: NaturalLanguageCase,
    observation: Observation,
    history: string[],
  ): Promise<Decision> {
    if (!this.apiKey)
      throw new Error('BLOCKED: AI_TEST_API_KEY is not configured');
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  testCase,
                  observation,
                  history: history.slice(-8),
                }),
              },
            ],
          },
        ],
        text: { format: { type: 'json_object' } },
      }),
    });
    if (!response.ok)
      throw new Error(
        `AI decision request failed: ${response.status} ${await response.text()}`,
      );
    const body = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text =
      body.output_text ??
      body.output
        ?.flatMap((item) => item.content ?? [])
        .map((item) => item.text ?? '')
        .join('');
    if (!text) throw new Error('AI returned no decision');
    return parseDecisionText(text);
  }
}
