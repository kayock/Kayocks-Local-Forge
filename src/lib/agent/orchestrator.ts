// Pipeline orchestration: planner → coder → tester → reviewer.
//
// Each stage is a real AgentRunner with its own system prompt, tool subset and
// model. Stages hand off via structured context messages; the reviewer can
// send the work back to the coder (rework pass). Same primitives extend to
// arbitrary multi-agent graphs (see docs/ARCHITECTURE.md).
import type { CompanionClient } from '@/lib/companion/client';
import type { InferenceParams, ProviderConfig } from '@/lib/types';
import type { AgentEvent, AgentMessage, Approver, ToolProtocolMode } from './types';
import { AgentRunner } from './runner';
import { toolsByNames } from './tools';
import { plannerPrompt, coderPrompt, testerPrompt, reviewerPrompt, type WorkspaceContext } from './prompts';

export type StageId = 'planner' | 'coder' | 'tester' | 'reviewer';

const STAGE_TOOLS: Record<StageId, string[]> = {
  planner: ['finish'],
  coder: ['list_dir', 'read_file', 'write_file', 'edit_file', 'create_dir', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_build', 'run_tests', 'finish'],
  tester: ['list_dir', 'read_file', 'write_file', 'edit_file', 'search_project', 'run_command', 'launch_app', 'process_status', 'stop_process', 'install_dependencies', 'run_tests', 'run_build', 'finish'],
  reviewer: ['list_dir', 'read_file', 'search_project', 'finish'],
};

export interface PipelineConfig {
  companion: CompanionClient;
  workspaceId: string;
  provider: ProviderConfig;
  model: string;
  // optional per-stage model override (model routing by task requirement)
  stageModels?: Partial<Record<StageId, string>>;
  // optional per-stage turn budgets
  stageMaxTurns?: Partial<Record<StageId, number>>;
  params?: Partial<InferenceParams>;
  task: string;
  workspaceContext: WorkspaceContext;
  maxTurnsPerStage?: number;
  reworkPasses?: number;
  // regex-source strings; writes/edits/deletes to matching paths are refused
  // in EVERY stage (forwarded to each AgentRunner)
  protectedPaths?: string[];
  // tool protocol mode forwarded to every stage (same scheme as AgentRunner)
  toolProtocol?: ToolProtocolMode | 'auto-native' | 'force-text';
  onEvent: (e: AgentEvent & { stage?: StageId | 'pipeline' }) => void;
  approver?: Approver;
  allowedPatterns?: Set<string>;
  signal?: AbortSignal;
}

export interface PipelineReport {
  plan: string;
  coderSummary: string;
  testReport: string;
  review: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'UNKNOWN';
  reworkPassesUsed: number;
  totalTurns: number;
}

function extractAfter(text: string, heading: string): string {
  const idx = text.lastIndexOf(heading);
  return idx >= 0 ? text.slice(idx + heading.length).trim() : text.trim();
}

export class PipelineRunner {
  constructor(private cfg: PipelineConfig) {}

  private stagePrompt(stage: StageId): string {
    const ctx = this.cfg.workspaceContext;
    switch (stage) {
      case 'planner': return plannerPrompt(ctx);
      case 'coder': return coderPrompt(ctx);
      case 'tester': return testerPrompt(ctx);
      case 'reviewer': return reviewerPrompt(ctx);
    }
  }

  private async runStage(stage: StageId, task: string, contextMessages: AgentMessage[]): Promise<{ content: string; turns: number }> {
    const model = this.cfg.stageModels?.[stage] || this.cfg.model;
    this.cfg.onEvent({ type: 'stage', stage });
    const runner = new AgentRunner({
      companion: this.cfg.companion,
      workspaceId: this.cfg.workspaceId,
      provider: this.cfg.provider,
      model,
      params: this.cfg.params,
      systemPrompt: this.stagePrompt(stage),
      task,
      contextMessages,
      tools: toolsByNames(STAGE_TOOLS[stage]),
      toolProtocol: this.cfg.toolProtocol,
      maxTurns: this.cfg.stageMaxTurns?.[stage] ?? this.cfg.maxTurnsPerStage ?? 30,
      allowNudgeOnText: true, // pipeline stages are task-mode by definition
      onEvent: (e) => this.cfg.onEvent({ ...e, stage }),
      approver: this.cfg.approver,
      allowedPatterns: this.cfg.allowedPatterns,
      protectedPaths: this.cfg.protectedPaths,
      signal: this.cfg.signal,
    });
    const res = await runner.run();
    return { content: res.content || '(no summary returned)', turns: res.turns };
  }

  async run(): Promise<PipelineReport> {
    const reworkLimit = this.cfg.reworkPasses ?? 1;
    let reworkUsed = 0;
    let totalTurns = 0;

    // 1. PLANNER
    const planRes = await this.runStage('planner', `Plan this task:\n\n${this.cfg.task}`, []);
    totalTurns += planRes.turns;
    const plan = extractAfter(planRes.content, 'PLAN:');
    this.cfg.onEvent({ type: 'notice', message: `Planner produced a ${plan.split('\n').length}-line plan.` });

    // 2. CODER
    const coderTask = `Implement this plan in the workspace.\n\nTASK:\n${this.cfg.task}\n\nPLAN:\n${plan}`;
    const coderRes = await this.runStage('coder', coderTask, []);
    totalTurns += coderRes.turns;

    // 3. TESTER (+ fix loop happens inside the tester's own turns)
    const testerTask = `Verify the implementation of this task:\n${this.cfg.task}\n\nPlan that was implemented:\n${plan}\n\nCoder summary:\n${coderRes.content}`;
    const testerRes = await this.runStage('tester', testerTask, []);
    totalTurns += testerRes.turns;

    // 4. REVIEWER (+ optional rework handoff)
    let review = '';
    let verdict: PipelineReport['verdict'] = 'UNKNOWN';
    let coderSummary = coderRes.content;
    let testReport = testerRes.content;

    for (let pass = 0; pass <= reworkLimit; pass++) {
      const reviewerTask = `Review this implementation:\n\nTASK:\n${this.cfg.task}\n\nCoder summary:\n${coderSummary}\n\nTester report:\n${testReport}`;
      const reviewerRes = await this.runStage('reviewer', reviewerTask, []);
      totalTurns += reviewerRes.turns;
      review = reviewerRes.content;
      verdict = /VERDICT:\s*APPROVE/i.test(review) ? 'APPROVE' : /VERDICT:\s*REQUEST_CHANGES/i.test(review) ? 'REQUEST_CHANGES' : 'UNKNOWN';

      if (verdict === 'APPROVE' || pass === reworkLimit) break;

      // handoff: back to coder with the review notes, then tester again
      reworkUsed++;
      this.cfg.onEvent({ type: 'notice', message: `Reviewer requested changes — rework pass ${reworkUsed}.` });
      const reworkTask = `A reviewer rejected the previous implementation. Fix these blocking issues and re-verify:\n\n${review}\n\nOriginal task:\n${this.cfg.task}`;
      const reworkRes = await this.runStage('coder', reworkTask, []);
      totalTurns += reworkRes.turns;
      coderSummary += `\n\n[Rework pass ${reworkUsed}] ${reworkRes.content}`;

      const retestRes = await this.runStage('tester', `Re-test after rework pass ${reworkUsed}.\nReviewer issues:\n${review}\n\nCoder summary:\n${reworkRes.content}`, []);
      totalTurns += retestRes.turns;
      testReport += `\n\n[Rework pass ${reworkUsed}] ${retestRes.content}`;
    }

    this.cfg.onEvent({ type: 'notice', message: `Pipeline complete — verdict: ${verdict}, ${totalTurns} model turns total.` });
    return { plan, coderSummary, testReport, review, verdict, reworkPassesUsed: reworkUsed, totalTurns };
  }
}
