import * as dotenv from 'dotenv';

dotenv.config();

export function getEnv(name: string): string {
  return process.env[name] || '';
}

export function getRunId(): string | undefined {
  return getEnv('RUN_ID') || undefined;
}

export function isAutoPrEnabled(): boolean {
  return getEnv('HEALER_AUTO_PR') === 'true';
}

export function getJenkinsUrl(): string | undefined {
  return getEnv('JENKINS_BUILD_URL') || undefined;
}
