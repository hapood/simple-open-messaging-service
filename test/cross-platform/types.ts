export type Platform = 'browser' | 'android';

export interface NaturalLanguageCase {
  id: string;
  title: string;
  goal: string;
  preconditions: string[];
  actions: string[];
  expectations: string[];
  source: string;
}

export interface ElementSummary {
  id?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  bounds?: string;
}

export interface Observation {
  platform: Platform;
  url?: string;
  title?: string;
  contexts?: string[];
  activeContext?: string;
  pageText: string;
  elements: ElementSummary[];
  screenshotBase64?: string;
  recentErrors: string[];
}

export type TestAction =
  | { type: 'tap'; target: string; reason: string }
  | { type: 'type'; target: string; text: string; reason: string }
  | { type: 'press'; key: 'ENTER' | 'BACK' | 'ESCAPE'; reason: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number; reason: string }
  | { type: 'switchContext'; context: 'webview' | 'native'; reason: string }
  | { type: 'wait'; milliseconds: number; reason: string }
  | { type: 'finish'; passed: boolean; reason: string };

export interface Decision {
  action: TestAction;
  evidence?: string;
}

export interface PlatformDriver {
  readonly platform: Platform;
  open(url: string): Promise<void>;
  observe(): Promise<Observation>;
  act(action: Exclude<TestAction, { type: 'finish' }>): Promise<void>;
  close(): Promise<void>;
}
