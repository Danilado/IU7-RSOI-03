export class ServiceUnavailable extends Error {
  readonly status = 503;
  constructor(readonly service: string) {
    // The supplied v4 Postman collection calls Rating Service "Bonus Service".
    super(
      `${service === "rating" ? "Bonus" : service === "library" ? "Library" : "Reservation"} Service unavailable`,
    );
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;
  constructor(
    private readonly threshold = 3,
    private readonly resetMs = 3000,
    private readonly now = Date.now,
  ) {}

  async execute<T>(
    operation: () => Promise<T>,
    unavailable: () => Error,
  ): Promise<T> {
    if (
      this.openedAt !== undefined &&
      (this.now() - this.openedAt < this.resetMs || this.probing)
    ) {
      throw unavailable();
    }
    const probe = this.openedAt !== undefined;
    if (probe) this.probing = true;
    try {
      const result = await operation();
      this.failures = 0;
      this.openedAt = undefined;
      return result;
    } catch (error) {
      // A business 4xx response proves that the service is available.
      if (!(error instanceof ServiceUnavailable)) {
        this.failures = 0;
        this.openedAt = undefined;
      } else if (probe || ++this.failures >= this.threshold) {
        this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (probe) this.probing = false;
    }
  }
}

interface Job {
  steps: Array<() => Promise<unknown>>;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

// Each job preserves its own order; an unavailable service does not block other jobs.
export class RetryQueue {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly retryMs = 10_000) {}
  get size(): number {
    return this.jobs.size;
  }

  async submit(key: string, steps: Job["steps"]): Promise<void> {
    if (this.jobs.has(key)) return;
    const job: Job = { steps: [...steps], running: false };
    this.jobs.set(key, job);
    await this.run(key, job);
  }

  private async run(key: string, job: Job): Promise<void> {
    if (job.running) return;
    job.running = true;
    try {
      while (job.steps.length) {
        await job.steps[0]();
        job.steps.shift();
      }
      this.jobs.delete(key);
    } catch (error) {
      console.warn(
        `Retry queued: ${key}`,
        error instanceof Error ? error.message : error,
      );
      job.timer = setTimeout(() => void this.run(key, job), this.retryMs);
      job.timer.unref();
    } finally {
      job.running = false;
    }
  }

  close(): void {
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }
}
