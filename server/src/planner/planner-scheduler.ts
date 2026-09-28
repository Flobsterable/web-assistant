import type { McpToolClient } from '../mcp/mcp-agent-runtime.js';
import { plannerSummaryPeriod, type PlannerCalendarEvent, type PlannerStore, type PlannerSummaryKind } from './planner-store.js';

export const TEST_DAILY_SUMMARY_INTERVAL_MS = 60_000;
export const TEST_WEEKLY_SUMMARY_INTERVAL_MS = 120_000;
export const CALENDAR_SYNC_HORIZON_DAYS = 90;

export class PlannerScheduler {
  private dailyTimer: NodeJS.Timeout | null = null;
  private weeklyTimer: NodeJS.Timeout | null = null;
  private running = false;
  private nextDailyRunAt: string | null = null;
  private nextWeeklyRunAt: string | null = null;
  private lastCalendarError: string | null = null;

  constructor(private readonly store: PlannerStore, private readonly calendarClient?: McpToolClient) {}

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
      weekly: { intervalMs: TEST_WEEKLY_SUMMARY_INTERVAL_MS, nextRunAt: this.nextWeeklyRunAt },
      calendar: { enabled: Boolean(this.calendarClient), lastError: this.lastCalendarError }
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
        const upcomingEvents = await this.listCalendarEventsBetween(
          now,
          new Date(now.getTime() + CALENDAR_SYNC_HORIZON_DAYS * 24 * 60 * 60 * 1_000)
        );
        this.store.syncCalendarEvents(profileId, upcomingEvents);
        if (kinds.includes('daily')) {
          const events = await this.listCalendarEvents('daily', now);
          this.store.syncCalendarEvents(profileId, events);
          this.store.createDailySummary(profileId, now, events);
        }
        if (kinds.includes('weekly')) {
          const events = await this.listCalendarEvents('weekly', now);
          this.store.syncCalendarEvents(profileId, events);
          this.store.createWeeklySummary(profileId, now, events);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async listCalendarEvents(kind: PlannerSummaryKind, now: Date): Promise<PlannerCalendarEvent[]> {
    const period = plannerSummaryPeriod(kind, now);
    return this.listCalendarEventsBetween(period.start, period.limit);
  }

  private async listCalendarEventsBetween(timeMin: Date, timeMax: Date): Promise<PlannerCalendarEvent[]> {
    if (!this.calendarClient) return [];
    try {
      const result = await this.calendarClient.callTool('google_calendar_list_events', {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: 50
      });
      if (result.isError) {
        this.lastCalendarError = result.content.map((item) => item.text).join('\n').slice(0, 500);
        return [];
      }
      const payload = result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent as Record<string, unknown>
        : JSON.parse(result.content.map((item) => item.text).join('\n')) as Record<string, unknown>;
      const events = Array.isArray(payload.events) ? payload.events : [];
      this.lastCalendarError = null;
      return events.flatMap((value): PlannerCalendarEvent[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const event = value as Record<string, unknown>;
        return [{
          id: typeof event.id === 'string' ? event.id : null,
          summary: typeof event.summary === 'string' ? event.summary : '(без названия)',
          start: typeof event.start === 'string' ? event.start : null,
          end: typeof event.end === 'string' ? event.end : null,
          location: typeof event.location === 'string' ? event.location : null,
          url: typeof event.url === 'string' ? event.url : null
        }];
      });
    } catch (error) {
      this.lastCalendarError = error instanceof Error ? error.message : 'Не удалось прочитать Google Calendar.';
      return [];
    }
  }
}
