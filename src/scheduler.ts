import { schedule, type ScheduledTask } from 'node-cron';
import { config } from './config';

let scheduledTask: ScheduledTask | null = null;
let reviewTask: ScheduledTask | null = null;

export function startScheduler(
  sendReport: () => Promise<void>,
  runAiReview?: () => Promise<void>,
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
}

export function stopScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop();
    scheduledTask = null;
  }
  if (reviewTask) {
    void reviewTask.stop();
    reviewTask = null;
  }
}
