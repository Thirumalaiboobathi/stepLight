export interface FixtureSites {
  url: string;
  collectorUrl: string;
  received: string[];
  close(): Promise<void>;
}
export function startFixtureSites(options?: { port?: number; collectorPort?: number }): Promise<FixtureSites>;
