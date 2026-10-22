import type { LaunchOptions } from '@playwright/test';
export const repositoryRoot: string;
export function browserLaunchOptions(
  env?: Record<string, string | undefined>,
): LaunchOptions;
