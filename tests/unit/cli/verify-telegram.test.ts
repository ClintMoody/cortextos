import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub fetch so validateCredentials' getMe/getChat probes resolve
// against a scripted queue. Each test primes the queue with the
// response pair the underlying TelegramAPI will consume.
type MockResponse = { status: number; body: unknown };
let responseQueue: MockResponse[] = [];

beforeEach(() => {
  responseQueue = [];
  vi.stubGlobal('fetch', vi.fn(async () => {
    const r = responseQueue.shift();
    if (!r) throw new Error('fetch called with no queued response');
    return {
      ok: r.status === 200,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

function queue(status: number, body: unknown) {
  responseQueue.push({ status, body });
}

async function loadCommand() {
  // Fresh import so commander's Command instance isn't shared across tests.
  const mod = await import('../../../src/cli/verify-telegram');
  return mod.verifyTelegramCommand;
}

function writeAgent(projectRoot: string, org: string, agent: string, envLines: string[]) {
  const agentDir = join(projectRoot, 'orgs', org, 'agents', agent);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, '.env'), envLines.join('\n'));
}

describe('cortextos verify-telegram <agent>', () => {
  let projectRoot: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let exits: number[];

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'verify-tg-'));
    process.env.CTX_FRAMEWORK_ROOT = projectRoot;
    logs = [];
    errs = [];
    exits = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.CTX_FRAMEWORK_ROOT;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('happy path: OK line printed, exit 0', async () => {
    writeAgent(projectRoot, 'acme', 'alice', ['BOT_TOKEN=111:AAA', 'CHAT_ID=777']);
    // getMe then getChat
    queue(200, { ok: true, result: { id: 222, username: 'alice_bot' } });
    queue(200, { ok: true, result: { type: 'private', id: 777 } });

    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'alice']); } catch {}

    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('OK: bot=@alice_bot');
    expect(logs.join('\n')).toContain('chat=777');
  });

  it('missing .env: exit 1, lists paths checked', async () => {
    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'ghost']); } catch {}

    expect(exits).toEqual([1]);
    expect(errs.join('\n')).toContain('No .env found for agent "ghost"');
  });

  it('missing BOT_TOKEN/CHAT_ID: exit 1, names the missing keys', async () => {
    writeAgent(projectRoot, 'acme', 'alice', ['BOT_TOKEN=111:AAA']);
    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'alice']); } catch {}

    expect(exits).toEqual([1]);
    expect(errs.join('\n')).toContain('missing required values: CHAT_ID');
  });

  it('bad_token: exit 1, formatted error + re-run hint', async () => {
    writeAgent(projectRoot, 'acme', 'alice', ['BOT_TOKEN=111:AAA', 'CHAT_ID=777']);
    queue(401, { ok: false, error_code: 401, description: 'Unauthorized' });

    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'alice']); } catch {}

    expect(exits).toEqual([1]);
    const err = errs.join('\n');
    expect(err).toContain('FAIL');
    expect(err).toContain('bad_token');
    expect(err).toContain('cortextos verify-telegram alice');
  });

  it('self_chat: exit 1, explicit reason', async () => {
    writeAgent(projectRoot, 'acme', 'alice', ['BOT_TOKEN=111:AAA', 'CHAT_ID=222']);
    // getMe returns id 222 — same as CHAT_ID → self_chat short-circuit
    queue(200, { ok: true, result: { id: 222, username: 'alice_bot' } });

    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'alice']); } catch {}

    expect(exits).toEqual([1]);
    expect(errs.join('\n')).toContain('self_chat');
  });

  it('network_error: exit 0 with warning (transient — do not hard-fail)', async () => {
    writeAgent(projectRoot, 'acme', 'alice', ['BOT_TOKEN=111:AAA', 'CHAT_ID=777']);
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));

    const cmd = await loadCommand();
    try { await cmd.parseAsync(['node', 'verify-telegram', 'alice']); } catch {}

    expect(exits).toEqual([0]);
    expect(errs.join('\n')).toContain('network_error');
  });
});
