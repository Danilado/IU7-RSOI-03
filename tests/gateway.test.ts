import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

process.env.LIBRARY_URL = "http://library.test";
process.env.RESERVATION_URL = "http://reservation.test";
process.env.RATING_URL = "http://rating.test";
process.env.RETRY_INTERVAL_MS = "20";
process.env.CB_RESET_MS = "25";
process.env.REQUEST_TIMEOUT_MS = "25";
const realFetch = global.fetch;
let libraryDown = false,
  ratingDown = false,
  reservationDown = false,
  checkoutFails = false;
let stock = 1,
  stars = 1;
let reservation: any;
const events: string[] = [];
let ratingHangs = false;
let ratingCalls = 0;
const book = {
  bookUid: "book",
  libraryUid: "library",
  name: "Book",
  libraryName: "Library",
  condition: "EXCELLENT",
  availableCount: 1,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
let baseUrl: string;
let server: Server;
let queue: { close(): void; size: number };

before(async () => {
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return realFetch(input, options);
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    if (url.includes("rating.test")) {
      ratingCalls++;
      if (ratingHangs) {
        return new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true },
          );
        });
      }
    }
    if (
      (url.includes("library.test") && libraryDown) ||
      (url.includes("rating.test") && ratingDown) ||
      (url.includes("reservation.test") && reservationDown)
    )
      throw new Error("connection refused");
    if (url.includes("library.test")) {
      if (path.endsWith("/checkout/cancel")) {
        events.push("cancel");
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/checkout")) {
        events.push("checkout");
        if (checkoutFails) return json({}, 500);
        stock--;
        return json({});
      }
      if (path.endsWith("/return")) {
        events.push("stock");
        stock++;
        return json({});
      }
      return json(book);
    }
    if (url.includes("rating.test")) {
      if (method === "POST") {
        events.push("rating");
        stars += JSON.parse(String(options.body)).delta;
      }
      return json({ stars });
    }
    if (method === "DELETE") {
      events.push("delete");
      reservation = undefined;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/return")) {
      events.push("returned");
      reservation.status = "RETURNED";
      return json(reservation);
    }
    if (method === "POST") {
      events.push("create");
      reservation = {
        ...JSON.parse(String(options.body)),
        status: "RENTED",
        startDate: "2026-10-08",
        rentedCondition: "EXCELLENT",
      };
      return json(reservation, 201);
    }
    return json(reservation ? [reservation] : []);
  };
  const { app, retryQueue } = await import("../gateway/src/index");
  queue = retryQueue;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  queue.close();
  global.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const request = (path: string, body?: unknown) =>
  realFetch(`${baseUrl}/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-User-Name": "reader", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const borrow = () =>
  request("reservations", {
    bookUid: "book",
    libraryUid: "library",
    tillDate: "2026-10-20",
  });

test("borrow creates reservation before checkout; failed checkout rolls back", async () => {
  checkoutFails = true;
  assert.equal((await borrow()).status, 503);
  assert.deepEqual(events, ["create", "checkout", "delete", "cancel"]);
  assert.equal(reservation, undefined);
  assert.equal(stock, 1);
  checkoutFails = false;
  events.length = 0;
  assert.equal((await borrow()).status, 200);
  assert.deepEqual(events, ["create", "checkout"]);
});

test("reservations fall back to UIDs when Library is unavailable; critical reads fail", async () => {
  libraryDown = true;
  const result = await request("reservations");
  assert.equal(result.status, 200);
  const [item] = (await result.json()) as any[];
  assert.deepEqual(item.book, { bookUid: "book" });
  assert.deepEqual(item.library, { libraryUid: "library" });
  assert.equal((await request("libraries?city=Москва")).status, 503);
  reservationDown = true;
  assert.equal((await request("reservations")).status, 503);
  reservationDown = false;
  libraryDown = false;
});

test("return responds 204 during outage and finishes stock then rating after recovery", async () => {
  libraryDown = true;
  ratingDown = true;
  events.length = 0;
  const result = await request(
    `reservations/${reservation.reservationUid}/return`,
    { date: "2026-10-10", condition: "EXCELLENT" },
  );
  assert.equal(result.status, 204);
  assert.equal(queue.size, 1);
  assert.deepEqual(events, ["returned"]);
  libraryDown = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, ["returned", "stock"]);
  assert.equal(stock, 1);
  ratingDown = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, ["returned", "stock", "rating"]);
  assert.equal(stars, 2);
  assert.equal(queue.size, 0);
});

test("upstream timeout returns 503; all rating reads use the circuit and recover", async () => {
  // Verify Rating is available before testing failures.
  assert.equal((await request("rating")).status, 200);
  ratingCalls = 0;
  ratingHangs = true;
  assert.equal((await request("rating")).status, 503);
  ratingHangs = false;
  ratingDown = true;
  assert.equal((await request("rating")).status, 503);
  assert.equal((await request("rating")).status, 503);
  assert.equal((await request("rating")).status, 503);
  assert.equal(ratingCalls, 3);
  ratingDown = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await request("rating")).status, 200);
  assert.equal(ratingCalls, 4);
});
