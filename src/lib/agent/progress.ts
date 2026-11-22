// ProgressTracker — coordinator-side distinction between ACTIVITY and
// PROGRESS (repair mission §5).
//
// The calculator failure showed the agent staying "busy" for 40 turns of
// workspace discovery while producing zero artifacts. Repeated directory
// listings are activity; creating required files, passing tests and resolved
// errors are progress. The runner feeds every executed/blocked tool outcome
// through note(); the recovery ladder reads `pressure` (the consecutive
// no-progress streak) to decide when to escalate from passive guidance to
// active coordinator recovery and, finally, an honest stalled verdict.
//
// "New information obtained from tools" counts as progress — but only the
// FIRST time: an identical output for an identical call is no new information,
// so the runner reports reads with unchanged output as activity.
export type ProgressKind = 'progress' | 'activity';

export interface ProgressEvent {
  kind: ProgressKind;
  at: number;
  detail?: string;
  source?: string; // tool call id
}

export interface ProgressSnapshot {
  progressEvents: number;
  activityEvents: number;
  pressure: number;          // consecutive activity events since last progress
  lastProgress?: string;     // detail of the most recent progress event
}

export class ProgressTracker {
  private events: ProgressEvent[] = [];
  private noProgressStreak = 0;

  note(kind: ProgressKind, detail?: string, source?: string) {
    this.events.push({ kind, at: Date.now(), detail, source });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    this.noProgressStreak = kind === 'progress' ? 0 : this.noProgressStreak + 1;
  }

  get pressure(): number {
    return this.noProgressStreak;
  }

  snapshot(): ProgressSnapshot {
    const progress = this.events.filter((e) => e.kind === 'progress');
    return {
      progressEvents: progress.length,
      activityEvents: this.events.length - progress.length,
      pressure: this.noProgressStreak,
      lastProgress: progress.length ? progress[progress.length - 1].detail : undefined,
    };
  }

  reset() {
    this.events = [];
    this.noProgressStreak = 0;
  }
}

// Shell commands that only LOOK at the workspace. Running them successfully is
// discovery activity, not progress (mission §5: "Do not treat every command
// execution as meaningful progress").
const DISCOVERY_CMD_RE = /^\s*(ls|dir|pwd|echo|cat|head|tail|wc|stat|du|df|which|type|file|tree|find|env|printenv|whoami|uname|date)\b/;

export function isDiscoveryCommand(cmd: string): boolean {
  return DISCOVERY_CMD_RE.test(String(cmd ?? ''));
}

// Classification used by the runner after every tool execution.
//   `fresh`  — the output differs from the previous identical call (new info)
//   `exit0`  — for commands/tests/builds: exited 0
export function classifyForProgress(tool: string, args: Record<string, any>, entry: { status: string; outcome?: string; output?: string; exitCode?: number | null }, opts?: { fresh?: boolean; discoveryCommand?: boolean }): ProgressKind {
  const ok = entry.status === 'ok' && entry.outcome !== 'blocked';
  if (tool === 'finish') return 'activity'; // completion is judged by the gate, not here
  if (ok && entry.outcome === 'ok-nonempty') {
    if (tool === 'write_file' || tool === 'edit_file' || tool === 'create_dir' || tool === 'extract_archive') return 'progress'; // artifact created/changed
    if (tool === 'browser_verify') return 'progress'; // captured verification evidence
    if (tool === 'read_file' || tool === 'list_dir' || tool === 'search_project' || tool === 'workspace_info' || tool === 'process_status') {
      return opts?.fresh ? 'progress' : 'activity'; // new information vs re-read
    }
    if (tool === 'run_command' || tool === 'run_tests' || tool === 'run_build' || tool === 'install_dependencies') {
      if (tool === 'run_command' && opts?.discoveryCommand) return 'activity';
      return (entry.exitCode === null || entry.exitCode === 0) ? 'progress' : 'activity';
    }
    return 'progress';
  }
  return 'activity'; // ok-empty, blocked, error, denied — nothing new learned
}
