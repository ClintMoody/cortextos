import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Spy on postActivity at module scope so createApproval's fire-and-forget
// call is observable without the test having to await it.
const postActivitySpy = vi.fn().mockResolvedValue(true);
vi.mock('../../../src/bus/system', () => ({
  postActivity: (...args: unknown[]) => postActivitySpy(...args),
}));
vi.mock('../../../src/bus/message', () => ({
  sendMessage: vi.fn(),
}));

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApproval, updateApproval, listPendingApprovals } from '../../../src/bus/approval';
import type { BusPaths } from '../../../src/types';

let testDir: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'orgs', 'TestOrg', 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-approval-test-'));
  paths = mkPaths(testDir);
  postActivitySpy.mockClear();
  postActivitySpy.mockResolvedValue(true);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('createApproval', () => {
  it('writes the approval JSON to pending/ and returns a stable id', () => {
    const id = createApproval(paths, 'bob', 'TestOrg', 'Deploy to prod', 'deployment', 'why this matters');
    expect(id).toMatch(/^approval_\d+_[a-zA-Z0-9]+$/);

    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);

    const approval = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    expect(approval.title).toBe('Deploy to prod');
    expect(approval.category).toBe('deployment');
    expect(approval.status).toBe('pending');
    expect(approval.requesting_agent).toBe('bob');
    expect(approval.org).toBe('TestOrg');
  });

  it('posts to the activity channel with Approve/Deny inline keyboard', () => {
    const id = createApproval(paths, 'bob', 'TestOrg', 'Push to main', 'deployment', 'rationale');

    expect(postActivitySpy).toHaveBeenCalledTimes(1);
    const [orgDir, ctxRoot, org, message, replyMarkup] = postActivitySpy.mock.calls[0] as [
      string,
      string,
      string,
      string,
      any,
    ];
    expect(String(orgDir)).toBe(join(testDir, 'orgs', 'TestOrg'));
    expect(String(ctxRoot)).toBe(testDir);
    expect(String(org)).toBe('TestOrg');
    expect(String(message)).toContain('Push to main');
    expect(String(message)).toContain('deployment');
    expect(String(message)).toContain('bob');
    expect(String(message)).toContain(id);

    // Inline keyboard: single row, two buttons, callback_data prefixes
    // keyed on the approval id.
    expect(replyMarkup).toBeDefined();
    const rows = replyMarkup.inline_keyboard;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0].callback_data).toBe(`appr_allow_${id}`);
    expect(rows[0][1].callback_data).toBe(`appr_deny_${id}`);
    // Button labels should clearly say Approve / Deny regardless of emoji.
    expect(String(rows[0][0].text)).toMatch(/Approve/);
    expect(String(rows[0][1].text)).toMatch(/Deny/);
  });

  it('activity-channel post is fire-and-forget: approval creation succeeds even when postActivity rejects', () => {
    postActivitySpy.mockRejectedValueOnce(new Error('activity channel unreachable'));

    // Must NOT throw — approval creation is the primary path, activity
    // channel posting is best-effort.
    const id = createApproval(paths, 'bob', 'TestOrg', 'Silent-skip test', 'other', 'context');

    // The approval file still lands on disk.
    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);
  });
});

describe('updateApproval (regression guard for activity-channel callback path)', () => {
  it('moves the approval file from pending/ to resolved/ with status+note', () => {
    // The handleActivityCallback path calls updateApproval with an audit
    // note ("via Telegram activity channel by <user>"). This test
    // regression-guards that updateApproval still produces the exact file
    // shape (move + status + resolved_by note) that the rest of the
    // system expects downstream.
    const id = createApproval(paths, 'bob', 'TestOrg', 'Test resolve', 'deployment');
    updateApproval(paths, id, 'approved', 'via Telegram activity channel by Clint (@clintm)');

    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    const resolvedFile = join(paths.approvalDir, 'resolved', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(false);
    expect(existsSync(resolvedFile)).toBe(true);

    const approval = JSON.parse(readFileSync(resolvedFile, 'utf-8'));
    expect(approval.status).toBe('approved');
    expect(approval.resolved_by).toBe('via Telegram activity channel by Clint (@clintm)');
    expect(approval.resolved_at).toBeTruthy();
  });

  it('throws a clear error when the approval id does not exist', () => {
    expect(() => updateApproval(paths, 'approval_999_nope', 'approved')).toThrow(/not found/);
  });
});

describe('listPendingApprovals', () => {
  it('returns only approvals still in pending/ (not resolved)', () => {
    const id1 = createApproval(paths, 'bob', 'TestOrg', 'Still pending', 'deployment');
    const id2 = createApproval(paths, 'bob', 'TestOrg', 'Will be resolved', 'deployment');
    updateApproval(paths, id2, 'approved');

    const pending = listPendingApprovals(paths);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id1);
  });
});
