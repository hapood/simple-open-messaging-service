import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { AndroidDriver } from './appium-driver.js';
import { AiAgent } from './ai-agent.js';
import { BrowserDriver } from './browser-driver.js';
import { loadCases } from './scenario-loader.js';
import type { Decision, PlatformDriver } from './types.js';

const root = resolve(import.meta.dirname, '../..');
const scenarioPath = process.env.CROSS_PLATFORM_SCENARIOS ?? resolve(root, 'docs/development/browser-e2e-test-plan.md');
const browserUrl = process.env.CROSS_PLATFORM_BROWSER_URL ?? 'http://localhost:3101/';
const maxSteps = Number(process.env.AI_TEST_MAX_STEPS ?? 24);

async function runCase(driver: PlatformDriver, title: string, goal: string, agent: AiAgent): Promise<boolean> {
  const cases = await loadCases(scenarioPath);
  const testCase = cases.find((item) => item.title.includes(title) || item.id === title);
  if (!testCase) throw new Error(`Case not found: ${title}`);
  const history: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const observation = await driver.observe();
    const decision = await agent.decide({ ...testCase, goal: goal || testCase.goal }, observation, history);
    history.push(JSON.stringify({ observation: summarize(observation), decision }));
    await writeArtifact(driver.platform, testCase.id, step, observation, decision);
    if (decision.action.type === 'finish') {
      console.log(`${driver.platform} ${testCase.id}: ${decision.action.passed ? 'PASS' : 'FAIL'} - ${decision.action.reason}`);
      return decision.action.passed;
    }
    await driver.act(decision.action);
  }
  console.error(`${driver.platform} ${testCase.id}: FAIL - step budget exhausted`);
  return false;
}

async function writeArtifact(platform: string, id: string, step: number, observation: unknown, decision: Decision) {
  const dir = process.env.AI_TEST_ARTIFACT_DIR ?? '/tmp/soms-cross-platform';
  await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(dir, { recursive: true }).then(() => writeFile(
    resolve(dir, `${platform}-${id}-${step}.json`),
    JSON.stringify({ observation, decision }, null, 2),
  )));
}

function summarize(observation: Awaited<ReturnType<PlatformDriver['observe']>>) {
  return { ...observation, screenshotBase64: observation.screenshotBase64 ? '[captured]' : undefined };
}

async function runPlatform(platform: 'browser' | 'android', agent: AiAgent): Promise<boolean> {
  const browser = platform === 'browser' ? await chromium.launch({
    headless: process.env.BROWSER_HEADFUL !== '1',
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  }) : undefined;
  const driver: PlatformDriver = platform === 'android' ? new AndroidDriver() : new BrowserDriver(browser!);
  try {
    await driver.open(platform === 'android' ? '' : browserUrl);
    return await runCase(driver, process.env.AI_TEST_CASE ?? '0.1', process.env.AI_TEST_GOAL ?? '', agent);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return false;
  } finally {
    await driver.close();
    await browser?.close();
  }
}

async function main() {
  const requested = process.env.CROSS_PLATFORM_PLATFORM ?? 'both';
  if (requested !== 'both' && requested !== 'browser' && requested !== 'android') {
    throw new Error(`Unsupported CROSS_PLATFORM_PLATFORM: ${requested}`);
  }
  const platforms: Array<'browser' | 'android'> = requested === 'both'
    ? ['browser', 'android']
    : [requested as 'browser' | 'android'];
  const agent = new AiAgent();
  const results = await Promise.all(platforms.map((platform) => runPlatform(platform, agent)));
  if (results.some((passed) => !passed)) process.exitCode = 1;
}

void main();
