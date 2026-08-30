import { execSync } from "node:child_process";
import type { ApiClient } from "../client/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("github-automation");

const GH_CHECK_INTERVAL = 60_000; // 60s

interface ActiveAutomation {
  id: string;
  board_id: string;
  repository_id: string;
  agent_id: string;
  name: string;
  full_name: string; // owner/repo
  rules_list: string[];
  last_processed_at: string | null;
}

interface AutomationEvent {
  id: string;
  event_type: string;
  subject: string;
  status: string;
  task_id: string | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

interface AutomationTask {
  id: string;
  status: string;
  pr_url: string | null;
  metadata: { github_issue_number?: number; github_issue_repo?: string; github_issue_url?: string };
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  url: string;
}

/**
 * GitHub automation poller: periodically reads issues/PRs of the repositories
 * bound by automation rules and drives the issue -> task -> PR -> close loop.
 *
 *   - new open issue         → POST issue.opened (server creates a bound task)
 *   - task in_review + PR    → gh issue comment, then POST issue.replied
 *   - task done (PR merged)  → gh issue close, then POST issue.closed
 *
 * PR state transitions (merged → task done) are already handled by PrMonitor.
 * All side effects are idempotent server-side via the event table unique key.
 */
export class GithubAutomationPoller {
  private client: ApiClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private failureCount = 0;

  constructor(client: ApiClient) {
    this.client = client;
  }

  start(): void {
    this.timer = setInterval(() => this.check().catch(() => {}), GH_CHECK_INTERVAL);
    void this.check();
    logger.info("GitHub automation poller started (interval=60s)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const automations = await this.client.getActiveAutomations();
      for (const automation of automations) {
        try {
          await this.pollAutomation(automation);
        } catch (err: any) {
          logger.warn(`Automation ${automation.name} poll failed: ${err.message}`);
        }
      }
      this.failureCount = 0;
    } catch (err: any) {
      this.failureCount++;
      if (this.failureCount === 10 || (this.failureCount > 10 && this.failureCount % 10 === 0)) {
        logger.error(`GitHub automation poller failed ${this.failureCount} consecutive checks: ${err.message}. Check gh auth status.`);
      } else if (this.failureCount < 10) {
        logger.warn(`GitHub automation poller error: ${err.message}`);
      }
    } finally {
      this.checking = false;
    }
  }

  private async pollAutomation(automation: ActiveAutomation): Promise<void> {
    const rules = new Set(automation.rules_list);
    if (rules.has("issue.opened")) await this.ingestNewIssues(automation);
    if (rules.has("issue.replied") || rules.has("pr.merged")) {
      await this.replyOnOpenPrs(automation);
      await this.closeIssuesForDoneTasks(automation);
    }
  }

  /** Report every open issue; the server dedupes and creates one task per issue. */
  private async ingestNewIssues(automation: ActiveAutomation): Promise<void> {
    const issues = listGhIssues(automation.full_name);
    if (issues === null) return;
    for (const issue of issues) {
      try {
        const event = (await this.client.reportAutomationEvent(automation.board_id, automation.id, {
          event_type: "issue.opened",
          subject: `${automation.full_name}#${issue.number}`,
          repository_id: automation.repository_id,
          issue: { title: issue.title, body: issue.body, url: issue.url, number: issue.number },
        })) as AutomationEvent;
        if (event.task_id) {
          logger.info(`Issue ${event.subject} tracked by task ${event.task_id}`);
        }
      } catch (err: any) {
        logger.warn(`Failed to record issue ${automation.full_name}#${issue.number}: ${err.message}`);
      }
    }
  }

  /** Comment on the issue once the task has a PR in review (idempotent). */
  private async replyOnOpenPrs(automation: ActiveAutomation): Promise<void> {
    const [tasks, events] = await Promise.all([
      this.client.listAutomationTasks(automation.id, { status: "in_review" }) as Promise<AutomationTask[]>,
      this.client.listAutomationEvents(automation.board_id, automation.id, { limit: 200 }) as Promise<{ data: AutomationEvent[] }>,
    ]);
    const replied = new Set(events.data.filter((e) => e.event_type === "issue.replied").map((e) => e.subject));

    for (const task of tasks) {
      const issueNumber = task.metadata?.github_issue_number;
      if (!issueNumber || !task.pr_url) continue;
      const subject = `${automation.full_name}#${issueNumber}`;
      if (replied.has(subject)) continue;

      const body = `已由自动化 agent 处理并提交 PR:\n\n- PR: ${task.pr_url}\n\nPR 合并后将自动关闭本 issue。`;
      if (!ghIssueComment(subject, body)) continue;

      try {
        const event = (await this.client.reportAutomationEvent(automation.board_id, automation.id, {
          event_type: "issue.replied",
          subject,
          repository_id: automation.repository_id,
        })) as AutomationEvent;
        await this.client.updateAutomationEvent(automation.board_id, automation.id, event.id, { status: "done", task_id: task.id });
        logger.info(`Replied on ${subject} (task ${task.id})`);
      } catch (err: any) {
        logger.warn(`Failed to record reply event for ${subject}: ${err.message}`);
      }
    }
  }

  /** Close the issue once its task is done (PR merged) — idempotent via issue.closed. */
  private async closeIssuesForDoneTasks(automation: ActiveAutomation): Promise<void> {
    const [tasks, events] = await Promise.all([
      this.client.listAutomationTasks(automation.id, { status: "done" }) as Promise<AutomationTask[]>,
      this.client.listAutomationEvents(automation.board_id, automation.id, { limit: 200 }) as Promise<{ data: AutomationEvent[] }>,
    ]);
    const closed = new Set(events.data.filter((e) => e.event_type === "issue.closed").map((e) => e.subject));

    for (const task of tasks) {
      const issueNumber = task.metadata?.github_issue_number;
      if (!issueNumber) continue;
      const subject = `${automation.full_name}#${issueNumber}`;
      if (closed.has(subject)) continue;

      if (!ghIssueClose(subject)) continue;

      try {
        const event = (await this.client.reportAutomationEvent(automation.board_id, automation.id, {
          event_type: "issue.closed",
          subject,
          repository_id: automation.repository_id,
        })) as AutomationEvent;
        await this.client.updateAutomationEvent(automation.board_id, automation.id, event.id, { status: "done", task_id: task.id });
        logger.info(`Closed ${subject} (task ${task.id})`);
      } catch (err: any) {
        logger.warn(`Failed to record close event for ${subject}: ${err.message}`);
      }
    }
  }
}

function listGhIssues(fullName: string): GhIssue[] | null {
  try {
    const raw = execSync(`gh issue list --repo "${fullName}" --state open --json number,title,body,createdAt,url -q .`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

function ghIssueComment(subject: string, body: string): boolean {
  try {
    execSync(`gh issue comment "${subject}" --body ${JSON.stringify(body)}`, { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    return true;
  } catch {
    logger.warn(`gh issue comment failed for ${subject}`);
    return false;
  }
}

function ghIssueClose(subject: string): boolean {
  try {
    execSync(`gh issue close "${subject}"`, { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    return true;
  } catch {
    logger.warn(`gh issue close failed for ${subject}`);
    return false;
  }
}
