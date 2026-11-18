import type { ChildProcess } from 'node:child_process';

export type DesktopOptions = {
  dataDir: string;
  enabled?: boolean;
  max?: number;
  idleMs?: number;
  leaseDir?: string;
  runtime?: {
    launch: (env: NodeJS.ProcessEnv, profile: string, proxySocket: string) => { child: ChildProcess; ready: Promise<void> };
    run: (args: string[], env: NodeJS.ProcessEnv, profile: string) => Promise<Buffer>;
    capture: (env: NodeJS.ProcessEnv, profile: string) => Promise<Buffer>;
  };
  now?: () => number;
  geometry?: string;
  testOnlyProxyTarget?: { hostname: string; port: number; httpsPort?: number };
};
