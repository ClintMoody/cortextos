import { Command } from 'commander';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { TelegramAPI, formatValidateError } from '../telegram/api.js';
import { discoverProjectRoot, parseEnvFile } from './enable-agent.js';

/**
 * Standalone diagnostic: read an existing agent's .env and run
 * TelegramAPI.validateCredentials() against it. Escape hatch for
 * operators who inherit a broken config and want to diagnose in one
 * command without running `enable` (which mutates state) or
 * restarting the daemon.
 *
 * Exit codes:
 *   0 — credentials valid, or probe blocked by a transient reason
 *       (network_error / rate_limited) — printed as a warning
 *   1 — credentials invalid (bad_token / chat_not_found / bot_recipient
 *       / self_chat), OR .env not found / missing required keys
 *   2 — validator crashed (should never happen; defensive)
 */
export const verifyTelegramCommand = new Command('verify-telegram')
  .argument('<agent>', 'Agent name whose .env will be probed')
  .option('--org <org>', 'Organization name (auto-detected from orgs/ if omitted)')
  .description("Probe an agent's BOT_TOKEN + CHAT_ID against the live Telegram API without mutating state")
  .action(async (agent: string, options: { org?: string }) => {
    const projectRoot = discoverProjectRoot();

    // Auto-detect org if not specified (same scan shape as enable).
    if (!options.org) {
      const orgsDir = join(projectRoot, 'orgs');
      if (existsSync(orgsDir)) {
        try {
          const orgs = readdirSync(orgsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          for (const o of orgs) {
            if (existsSync(join(orgsDir, o, 'agents', agent))) {
              options.org = o;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    }

    const orgDir = options.org ? join(projectRoot, 'orgs', options.org) : null;

    let agentEnvPath: string | null = null;
    if (orgDir) {
      const candidate = join(orgDir, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }
    if (!agentEnvPath) {
      const candidate = join(projectRoot, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }

    if (!agentEnvPath) {
      console.error(`Error: No .env found for agent "${agent}". Checked:`);
      if (orgDir) console.error(`  - ${join(orgDir, 'agents', agent, '.env')}`);
      console.error(`  - ${join(projectRoot, 'agents', agent, '.env')}`);
      console.error(`Project root: ${projectRoot}`);
      process.exit(1);
    }

    const env = parseEnvFile(agentEnvPath);
    const missing = (['BOT_TOKEN', 'CHAT_ID'] as const).filter(k => !env[k]);
    if (missing.length > 0) {
      console.error(`Error: .env for agent "${agent}" is missing required values: ${missing.join(', ')}`);
      console.error(`  Path: ${agentEnvPath}`);
      process.exit(1);
    }

    let validation;
    try {
      const api = new TelegramAPI(env.BOT_TOKEN);
      validation = await api.validateCredentials(env.CHAT_ID);
    } catch (err) {
      console.error(`Error: Telegram credential validation crashed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
      return;
    }

    if (validation.ok) {
      const label = validation.chatTitle ? ` (${validation.chatTitle})` : '';
      console.log(
        `OK: bot=@${validation.botUsername} chat=${env.CHAT_ID} type=${validation.chatType}${label}`,
      );
      console.log(`  Source: ${agentEnvPath}`);
      process.exit(0);
    }
    if (validation.reason === 'network_error' || validation.reason === 'rate_limited') {
      console.error(`Warning: could not verify Telegram credentials (${validation.reason}).`);
      console.error(`  ${formatValidateError(validation)}`);
      console.error(`  Source: ${agentEnvPath}`);
      process.exit(0);
    }
    console.error(`FAIL: Telegram credentials for agent "${agent}" failed validation.`);
    console.error(`  Reason: ${validation.reason}`);
    console.error(`  ${formatValidateError(validation)}`);
    console.error(`  Edit ${agentEnvPath} and re-run: cortextos verify-telegram ${agent}`);
    process.exit(1);
  });
