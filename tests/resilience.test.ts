import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  RetryQueue,
  ServiceUnavailable,
} from "../gateway/src/resilience";

const unavailable = () => new ServiceUnavailable("library");

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
