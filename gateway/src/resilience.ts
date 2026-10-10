export class ServiceUnavailable extends Error {
  readonly status = 503;
  constructor(readonly service: string) {
    super(`${service === "rating" ? "Bonus" : service === "library" ? "Library" : "Reservation"} Service unavailable`);
  }
}

class FailureRingBuffer {
  private readonly timestamps: Float64Array;
  private head = 0;
  private size = 0;

  constructor(capacity: number, private readonly windowMs: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Circuit breaker threshold must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("Circuit breaker window must be positive and finite");
    }
    this.timestamps = new Float64Array(capacity);
  }

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    // The window is (now - windowMs, now]; exactly windowMs-old failures expire.
    while (this.size > 0 && this.timestamps[this.head] <= cutoff) {
      this.head = (this.head + 1) % this.timestamps.length;
      this.size--;
    }
  }

  record(now: number): boolean {
    this.prune(now);
    const tail = (this.head + this.size) % this.timestamps.length;
    this.timestamps[tail] = now;
    if (this.size === this.timestamps.length) {
      this.head = (this.head + 1) % this.timestamps.length;
    } else {
      this.size++;
    }
    return this.size === this.timestamps.length;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

export class CircuitBreaker {
  private readonly history: FailureRingBuffer;
  private openedAt: number | undefined;
  private probing = false;
  private generation = 0;
  constructor(
    threshold = 3,
    private readonly resetMs = 3000,
    private readonly now = Date.now,
    windowMs = 60_000,
  ) {
    this.history = new FailureRingBuffer(threshold, windowMs);
  }

  async execute<T>(operation: () => Promise<T>, unavailable: () => Error): Promise<T> {
    const startedAt = this.now();
    this.history.prune(startedAt);
    if (this.openedAt !== undefined && (startedAt - this.openedAt < this.resetMs || this.probing)) {
      throw unavailable();
    }
    const probe = this.openedAt !== undefined;
    const generation = this.generation;
    if (probe) this.probing = true;
    const recovered = () => {
      // Ordinary successes preserve failures. A successful probe starts a new cycle.
      if (probe && generation === this.generation) {
        this.history.clear();
        this.openedAt = undefined;
        this.generation++;
      }
    };
    try {
      const result = await operation();
      recovered();
      return result;
    } catch (error) {
      // A business 4xx response proves that the service is available.
      if (!(error instanceof ServiceUnavailable)) {
        recovered();
      } else if (generation === this.generation) {
        const failedAt = this.now();
        const thresholdReached = this.history.record(failedAt);
        if (probe || thresholdReached) {
          this.openedAt = failedAt;
          this.generation++;
        }
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
      console.warn(`Retry queued: ${key}`, error instanceof Error ? error.message : error);
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
