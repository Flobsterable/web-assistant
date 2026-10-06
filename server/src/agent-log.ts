import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryEvent } from './memory.js';

export type AgentLogStep = {
  id: string;
  operation: string;
  status: 'started' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  memoryEvents?: MemoryEvent[];
  invariantCompliance?: {
    status: 'allowed' | 'conflict' | 'uncertain';
    phase: 'request' | 'response' | null;
    appliedIds: string[];
    violations: Array<{ id: string; reason: string }>;
    explanation: string;
  };
  error?: string;
};

export type AgentTurnLog = { version: 1; turnId: string; sessionId: string; createdAt: string; steps: AgentLogStep[] };

export class AgentTurnLogger {
  readonly turnId = `turn-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(16).slice(2, 8)}`;
  private readonly log: AgentTurnLog;
  constructor(private readonly rootPath: string, readonly sessionId: string) {
    this.log = { version: 1, turnId: this.turnId, sessionId, createdAt: new Date().toISOString(), steps: [] };
  }

  async step<T>(operation: string, action: () => Promise<T>, metadata: Partial<AgentLogStep> = {}): Promise<T> {
    const step: AgentLogStep = { id: `${this.turnId}-${this.log.steps.length + 1}`, operation, status: 'started', startedAt: new Date().toISOString(), ...metadata };
    this.log.steps.push(step);
    await this.save();
    const started = Date.now();
    try {
      const result = await action();
      Object.assign(step, { status: 'completed', completedAt: new Date().toISOString(), durationMs: Date.now() - started });
      await this.save();
      return result;
    } catch (error) {
      Object.assign(step, { status: 'failed', completedAt: new Date().toISOString(), durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      await this.save();
      throw error;
    }
  }

  async annotate(operation: string, metadata: Partial<AgentLogStep>) {
    const step = [...this.log.steps].reverse().find((item) => item.operation === operation);
    if (step) Object.assign(step, metadata);
    await this.save();
  }

  private async save() {
    const directory = path.join(this.rootPath, this.sessionId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${this.turnId}.json`);
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.log, null, 2)}\n`, 'utf8');
    await rename(temporary, filePath);
  }
}

export async function listAgentLogs(rootPath: string, sessionId: string): Promise<AgentTurnLog[]> {
  const directory = path.join(rootPath, sessionId);
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort().reverse();
    return Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8').then((raw) => JSON.parse(raw) as AgentTurnLog)));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readAgentLog(rootPath: string, sessionId: string, turnId: string): Promise<AgentTurnLog | null> {
  try {
    return JSON.parse(await readFile(path.join(rootPath, sessionId, `${turnId}.json`), 'utf8')) as AgentTurnLog;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
