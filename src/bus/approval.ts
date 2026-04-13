import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Fire-and-forget — if the activity channel
 * is unconfigured, unreachable, or the post fails, approval creation
 * still succeeds (the file-based state store is the source of truth,
 * and the dashboard UI path always works regardless).
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context?: string,
): void {
  const orgDir = join(paths.ctxRoot, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId)).catch(() => {
    // Best-effort — swallow errors, the approval itself already landed.
  });
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 */
export function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
): string {
  validateApprovalCategory(category);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
  };

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  // Fan-out to the activity channel so Clint can approve/deny from Telegram
  // without opening the dashboard. Fire-and-forget: if the channel is not
  // configured (no activity-channel.env) or unreachable, approval creation
  // still succeeds. Callbacks route back via the orchestrator's
  // activity-channel poller (see daemon/agent-manager.ts).
  postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context);

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
): void {
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval: Approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;

    // Move to resolved/ directory (matches bash version)
    const destDir = join(paths.approvalDir, 'resolved');
    ensureDir(destDir);
    atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

    // Remove from pending
    const { unlinkSync } = require('fs');
    unlinkSync(filePath);

    // Notify requesting agent via inbox
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : '';
      const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
      sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}

/**
 * List pending approvals.
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      approvals.push(JSON.parse(content));
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
