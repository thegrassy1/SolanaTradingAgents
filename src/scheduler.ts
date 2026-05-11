import { schedule, type ScheduledTask } from 'node-cron';
import { config } from './config';

let scheduledTask: ScheduledTask | null = null;
let reviewTask: ScheduledTask | null = null;
let flywheelRefreshTask: ScheduledTask | null = null;
let flywheelHealthTask: ScheduledTask | null = null;
let flywheelScoutTask: ScheduledTask | null = null;

export interface FlywheelCallbacks {
  refresh: () => Promise<void>;
  health: () => Promise<void>;
  scout: () => Promise<void>;
}

export function startScheduler(
  sendReport: () => Promise<void>,
  runAiReview?: () => Promise<void>,
  flywheel?: FlywheelCallbacks,
): void {
  stopScheduler();
  const cronExpr = config.reportCron;
  const timezone = config.reportTimezone;
  scheduledTask = schedule(
    cronExpr,
    () => {
      void sendReport();
    },
    { timezone },
  );
  console.log(
    `[SCHEDULER] Next report scheduled: ${cronExpr} in ${timezone}`,
  );

  if (runAiReview && config.anthropicApiKey) {
    const reviewCron = config.aiReviewCron;
    reviewTask = schedule(
      reviewCron,
      () => {
        void runAiReview();
      },
      { timezone },
    );
    console.log(
      `[SCHEDULER] AI reviewer scheduled: ${reviewCron} in ${timezone}`,
    );
  }

  if (flywheel) {
    // Hourly: refresh historical data so backtests are current
    flywheelRefreshTask = schedule('5 * * * *', () => { void flywheel.refresh(); }, { timezone });
    // Every 6h at minute 15: health-check the whitelist
    flywheelHealthTask = schedule('15 */6 * * *', () => { void flywheel.health(); }, { timezone });
    // Daily at 04:30: scout for new edges
    flywheelScoutTask = schedule('30 4 * * *', () => { void flywheel.scout(); }, { timezone });
    console.log(`[SCHEDULER] Flywheel scheduled: refresh hourly · health every 6h · scout daily 04:30 ${timezone}`);
  }
}

export function stopScheduler(): void {
  for (const t of [scheduledTask, reviewTask, flywheelRefreshTask, flywheelHealthTask, flywheelScoutTask]) {
    if (t) void t.stop();
  }
  scheduledTask = null;
  reviewTask = null;
  flywheelRefreshTask = null;
  flywheelHealthTask = null;
  flywheelScoutTask = null;
}
