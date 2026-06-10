import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface AppConfig {
  app: {
    name: string;
    tagline: string;
    url: string;
    description: string;
    stack: string;
  };
  guild_id: string;
  owner_id: string;
  channels: Record<string, string>;
  roles: Record<string, string>;
  rules_message_id: string;
  personality: {
    name: string;
    tone: string;
    morning_hour: number;
    lunch_hour: number;
    timezone: string;
  };
  faq: Array<{ q: string; a: string }>;
  jokes: string[];
}

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath || process.env.BOT_CONFIG_PATH;
  if (!path) {
    throw new Error(
      'No config path. Set BOT_CONFIG_PATH env or pass --config <path>'
    );
  }
  const resolved = path.startsWith('/') ? path : join(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new Error(`Config not found: ${resolved}`);
  }
  return JSON.parse(readFileSync(resolved, 'utf-8'));
}

/** Load all JSON configs from a directory, keyed by guild_id */
export function loadAllConfigs(configDir: string): Map<string, AppConfig> {
  const resolved = configDir.startsWith('/') ? configDir : join(process.cwd(), configDir);
  const configs = new Map<string, AppConfig>();

  if (!existsSync(resolved)) {
    throw new Error(`Config directory not found: ${resolved}`);
  }

  for (const file of readdirSync(resolved)) {
    if (!file.endsWith('.json')) continue;
    try {
      const cfg: AppConfig = JSON.parse(
        readFileSync(join(resolved, file), 'utf-8')
      );
      if (cfg.guild_id && cfg.channels && Object.keys(cfg.channels).length > 0) {
        configs.set(cfg.guild_id, cfg);
        console.log(`[config] loaded ${cfg.app.name} (${cfg.guild_id}) from ${file}`);
      } else {
        console.log(`[config] skipped ${file} (no guild_id or channels)`);
      }
    } catch (err) {
      console.error(`[config] failed to load ${file}:`, err);
    }
  }

  return configs;
}
