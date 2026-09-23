import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFailureOutcome } from './decision-schema.js';
import { AndroidDriver } from './appium-driver.js';
import { AiAgent } from './ai-agent.js';
import { BrowserDriver } from './browser-driver.js';
import { loadCases } from './scenario-loader.js';
import type {
  Decision,
  Platform,
  PlatformDriver,
  TestOutcome,
} from './types.js';

const root = resolve(import.meta.dirname, '../..');
const scenarioPath =
  process.env.CROSS_PLATFORM_SCENARIOS ??
  resolve(root, 'docs/development/browser-e2e-test-plan.md');
const browserUrl =
  process.env.CROSS_PLATFORM_BROWSER_URL ?? 'http://localhost:3101/';
const maxSteps = Number(process.env.AI_TEST_MAX_STEPS ?? 24);
const artifactDir =
  process.env.AI_TEST_ARTIFACT_DIR ?? '/tmp/soms-cross-platform';

type RunResult = {
  platform: Platform;
  caseId: string;
  title: string;
  outcome: TestOutcome;
  reason: string;
  steps: number;
};

export function selectCase(
  cases: Awaited<ReturnType<typeof loadCases>>,
  selector: string,
) {
  const exact = cases.find((item) => item.id === selector);
  if (exact) return exact;
  const matches = cases.filter((item) => item.title.includes(selector));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Case selector matched multiple titles: ${matches.map((item) => `${item.id} ${item.title}`).join('; ')}`,
    );
  }
  throw new Error(`Case not found: ${selector}`);
}

export function requiresCoordinatedMultiUser(
  title: string,
  goal: string,
): boolean {
  const participants = new Set(
    [
      ...`${title}\n${goal}`.matchAll(/\b(Alice|Bob|Charlie|Diana|Admin)\b/gi),
    ].map((match) => match[1].toLowerCase()),
  );
  return participants.size > 1;
}

async function runCase(
  driver: PlatformDriver,
  title: string,
  goal: string,
  agent: AiAgent,
): Promise<RunResult> {
  const cases = await loadCases(scenarioPath);
  const testCase = selectCase(cases, title);
  const effectiveGoal = goal || testCase.goal;
  if (requiresCoordinatedMultiUser(testCase.title, effectiveGoal)) {
    return {
      platform: driver.platform,
      caseId: testCase.id,
      title: testCase.title,
      outcome: 'BLOCKED',
      reason:
        'The adaptive runner currently controls one participant only; this case requires coordinated multi-user execution.',
      steps: 0,
    };
  }

  const history: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const observation = await driver.observe();
    const decision = await agent.decide(
      { ...testCase, goal: effectiveGoal },
      observation,
      history,
    );
    history.push(
      JSON.stringify({ observation: summarize(observation), decision }),
    );
    await writeArtifact(
      driver.platform,
      testCase.id,
      step,
      observation,
      decision,
    );
    if (decision.action.type === 'finish') {
      console.log(
        `${driver.platform} ${testCase.id}: ${decision.action.outcome} - ${decision.action.reason}`,
      );
      return {
        platform: driver.platform,
        caseId: testCase.id,
        title: testCase.title,
        outcome: decision.action.outcome,
        reason: decision.action.reason,
        steps: step + 1,
      };
    }
    await driver.act(decision.action);
  }
  console.error(
    `${driver.platform} ${testCase.id}: FAIL - step budget exhausted`,
  );
  return {
    platform: driver.platform,
    caseId: testCase.id,
    title: testCase.title,
    outcome: 'FAIL',
    reason: 'Step budget exhausted',
    steps: maxSteps,
  };
}

async function writeArtifact(
  platform: string,
  id: string,
  step: number,
  observation: unknown,
  decision: Decision,
) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `${platform}-${id}-${step}.json`),
    JSON.stringify({ observation, decision }, null, 2),
  );
}

function summarize(
  observation: Awaited<ReturnType<PlatformDriver['observe']>>,
) {
  return {
    ...observation,
    screenshotBase64: observation.screenshotBase64 ? '[captured]' : undefined,
  };
}

async function runPlatform(
  platform: Platform,
  agent: AiAgent,
): Promise<RunResult> {
  const browser =
    platform === 'browser'
      ? await chromium.launch({
          headless: process.env.BROWSER_HEADFUL !== '1',
          executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        })
      : undefined;
  const driver: PlatformDriver =
    platform === 'android' ? new AndroidDriver() : new BrowserDriver(browser!);
  const caseSelector = process.env.AI_TEST_CASE ?? '0.1';
  try {
    await driver.open(platform === 'android' ? '' : browserUrl);
    return await runCase(
      driver,
      caseSelector,
      process.env.AI_TEST_GOAL ?? '',
      agent,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(reason);
    return {
      platform,
      caseId: caseSelector,
      title: caseSelector,
      outcome: 'BLOCKED',
      reason,
      steps: 0,
    };
  } finally {
    await driver.close();
    await browser?.close();
  }
}

export async function writeResultFile(
  results: RunResult[],
  directory = artifactDir,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify({ results }, null, 2),
  );
}

async function main() {
  const requested = process.env.CROSS_PLATFORM_PLATFORM ?? 'both';
  if (
    requested !== 'both' &&
    requested !== 'browser' &&
    requested !== 'android'
  ) {
    throw new Error(`Unsupported CROSS_PLATFORM_PLATFORM: ${requested}`);
  }
  const platforms: Platform[] =
    requested === 'both' ? ['browser', 'android'] : [requested as Platform];
  const agent = new AiAgent();
  const results = await Promise.all(
    platforms.map((platform) => runPlatform(platform, agent)),
  );
  await writeResultFile(results);
  if (results.some((result) => isFailureOutcome(result.outcome)))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
