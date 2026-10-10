import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  RetryQueue,
  ServiceUnavailable,
} from "../gateway/src/resilience";

const unavailable = () => new ServiceUnavailable("library");

test("failures accumulate within a minute despite successful and business responses", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(3, 100, () => now);
  const fail = () => breaker.execute(async () => { throw unavailable(); }, unavailable);
  await assert.rejects(fail());
  now = 20_000;
  assert.equal(await breaker.execute(async () => "ok", unavailable), "ok");
  await assert.rejects(fail());
  now = 40_000;
  await assert.rejects(breaker.execute(async () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  }, unavailable));
  await assert.rejects(fail());
  await assert.rejects(breaker.execute(async () => assert.fail("open circuit"), unavailable));
});

test("failures expire exactly at the minute boundary and buffer wraps repeatedly", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(3, 100, () => now);
  const fail = () => breaker.execute(async () => { throw unavailable(); }, unavailable);
  // Keep two recent failures; each new minute expires the oldest pair.
  for (let cycle = 0; cycle < 4; cycle++) {
    now = cycle * 60_000;
    await assert.rejects(fail());
    now += 10_000;
    await assert.rejects(fail());
    assert.equal(await breaker.execute(async () => "ok", unavailable), "ok");
  }
  now += 10_000;
  await assert.rejects(fail());
  await assert.rejects(breaker.execute(async () => assert.fail("open circuit"), unavailable));
});

test("failed probe reopens even after the failure window expires", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(2, 100, () => now);
  const fail = () => breaker.execute(async () => { throw unavailable(); }, unavailable);
  await assert.rejects(fail());
  await assert.rejects(fail());
  now = 60_000;
  await assert.rejects(fail());
  await assert.rejects(breaker.execute(async () => assert.fail("probe cooldown"), unavailable));
});

test("successful probe starts a fresh window", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(2, 100, () => now);
  const fail = () => breaker.execute(async () => { throw unavailable(); }, unavailable);
  await assert.rejects(fail());
  await assert.rejects(fail());
  now = 100;
  await breaker.execute(async () => "recovered", unavailable);
  await assert.rejects(fail());
  assert.equal(await breaker.execute(async () => "ok", unavailable), "ok");
  await assert.rejects(fail());
  await assert.rejects(breaker.execute(async () => assert.fail("open again"), unavailable));
});

test("late responses from requests started before opening do not affect recovery", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(1, 100, () => now);
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const lateSuccess = breaker.execute(() => new Promise<void>(r => { resolve = r; }), unavailable);
  const lateFailure = breaker.execute(() => new Promise<void>((_, r) => { reject = r; }), unavailable);
  await assert.rejects(breaker.execute(async () => { throw unavailable(); }, unavailable));
  resolve();
  await lateSuccess;
  await assert.rejects(breaker.execute(async () => assert.fail("late success closed circuit"), unavailable));
  now = 100;
  await breaker.execute(async () => "recovered", unavailable);
  reject(unavailable());
  await assert.rejects(lateFailure);
  assert.equal(await breaker.execute(async () => "ok", unavailable), "ok");
});

test("ring buffer rejects invalid capacities", () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new CircuitBreaker(capacity), RangeError);
  }
  for (const windowMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => new CircuitBreaker(3, 100, Date.now, windowMs), RangeError);
  }
});

test("N failures open the circuit; N+1 skips upstream; a successful probe closes it", async () => {
  let now = 0,
    calls = 0;
  const breaker = new CircuitBreaker(2, 100, () => now);
  const fail = async () => {
    calls++;
    throw unavailable();
  };
  await assert.rejects(breaker.execute(fail, unavailable));
  await assert.rejects(breaker.execute(fail, unavailable));
  await assert.rejects(breaker.execute(fail, unavailable));
  assert.equal(calls, 2);
  now = 100;
  assert.equal(await breaker.execute(async () => ++calls, unavailable), 3);
  assert.equal(await breaker.execute(async () => ++calls, unavailable), 4);
});

test("half-open permits one probe and reopens when the probe fails", async () => {
  let now = 0;
  const breaker = new CircuitBreaker(1, 100, () => now);
  await assert.rejects(
    breaker.execute(async () => {
      throw unavailable();
    }, unavailable),
  );
  now = 100;
  let reject!: (reason: unknown) => void;
  const pending = breaker.execute(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
    unavailable,
  );
  await assert.rejects(
    breaker.execute(async () => assert.fail("parallel probe"), unavailable),
  );
  reject(unavailable());
  await assert.rejects(pending);
  await assert.rejects(
    breaker.execute(async () => assert.fail("early retry"), unavailable),
  );
});

test("business errors do not open the circuit", async () => {
  const breaker = new CircuitBreaker(1);
  await assert.rejects(
    breaker.execute(async () => {
      throw Object.assign(new Error("missing"), { status: 404 });
    }, unavailable),
  );
  assert.equal(await breaker.execute(async () => 42, unavailable), 42);
});

test("queue resumes at failed step and preserves library-before-rating order", async () => {
  const queue = new RetryQueue(10);
  const events: string[] = [];
  let attempts = 0;
  try {
    await queue.submit("return:1", [
      async () => {
        events.push("library");
      },
      async () => {
        events.push("rating");
        if (++attempts === 1) throw unavailable();
      },
    ]);
    assert.equal(queue.size, 1);
    await queue.submit("return:1", [async () => assert.fail("duplicate job")]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(events, ["library", "rating", "rating"]);
    assert.equal(queue.size, 0);
  } finally {
    queue.close();
  }
});

test("failed library step delays rating but does not block a separate job", async () => {
  const queue = new RetryQueue(10);
  let available = false;
  const events: string[] = [];
  try {
    await queue.submit("first", [
      async () => {
        if (!available) throw unavailable();
        events.push("library");
      },
      async () => {
        events.push("rating");
      },
    ]);
    await queue.submit("second", [
      async () => {
        events.push("other");
      },
    ]);
    assert.deepEqual(events, ["other"]);
    available = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(events, ["other", "library", "rating"]);
  } finally {
    queue.close();
  }
});
