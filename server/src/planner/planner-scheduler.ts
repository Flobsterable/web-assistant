import type { PlannerStore } from './planner-store.js';

export const TEST_DAILY_SUMMARY_INTERVAL_MS = 60_000;
export const TEST_WEEKLY_SUMMARY_INTERVAL_MS = 120_000;

export class PlannerScheduler {
  private dailyTimer: NodeJS.Timeout | null = null;
  private weeklyTimer: NodeJS.Timeout | null = null;
  private running = false;
  private nextDailyRunAt: string | null = null;
  private nextWeeklyRunAt: string | null = null;

  constructor(private readonly store: PlannerStore) {}

  start(): void {
    if (this.dailyTimer || this.weeklyTimer) return;
    void this.tick();
    this.nextDailyRunAt = new Date(Date.now() + TEST_DAILY_SUMMARY_INTERVAL_MS).toISOString();
    this.nextWeeklyRunAt = new Date(Date.now() + TEST_WEEKLY_SUMMARY_INTERVAL_MS).toISOString();
    this.dailyTimer = setInterval(() => {
      void this.tickDaily();
      this.nextDailyRunAt = new Date(Date.now() + TEST_DAILY_SUMMARY_INTERVAL_MS).toISOString();
    }, TEST_DAILY_SUMMARY_INTERVAL_MS);
    this.weeklyTimer = setInterval(() => {
      void this.tickWeekly();
      this.nextWeeklyRunAt = new Date(Date.now() + TEST_WEEKLY_SUMMARY_INTERVAL_MS).toISOString();
    }, TEST_WEEKLY_SUMMARY_INTERVAL_MS);
    this.dailyTimer.unref();
    this.weeklyTimer.unref();
  }

  status() {
    return {
      daily: { intervalMs: TEST_DAILY_SUMMARY_INTERVAL_MS, nextRunAt: this.nextDailyRunAt },
      weekly: { intervalMs: TEST_WEEKLY_SUMMARY_INTERVAL_MS, nextRunAt: this.nextWeeklyRunAt }
    };
  }

  async tick(now = new Date()): Promise<void> {
    await this.run(['daily', 'weekly'], now);
  }

  async tickDaily(now = new Date()): Promise<void> {
    await this.run(['daily'], now);
  }

  async tickWeekly(now = new Date()): Promise<void> {
    await this.run(['weekly'], now);
  }

  private async run(kinds: Array<'daily' | 'weekly'>, now: Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const profileId of this.store.listProfileIds()) {
        if (kinds.includes('daily')) this.store.createDailySummary(profileId, now);
        if (kinds.includes('weekly')) this.store.createWeeklySummary(profileId, now);
      }
    } finally {
      this.running = false;
    }
  }
}
