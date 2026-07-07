export interface Job {
  id: string;
  run(): Promise<void>;
}

export async function runWithRetry(job: Job): Promise<void> {
  let attempts = 0;
  let lastError: unknown;

  while (attempts < 3) {
    try {
      await job.run();
      return;
    } catch (error) {
      lastError = error;
      attempts += 1;
    }
  }

  throw new Error(`Job ${job.id} failed after ${attempts} attempts: ${String(lastError)}`);
}
