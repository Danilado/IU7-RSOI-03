import test from "node:test";
import assert from "node:assert/strict";
import { canBorrow, ratingDelta } from "../gateway/src/rules";

test("borrowing is allowed below the star limit", () => {
  assert.equal(canBorrow(0, 1), true);
  assert.equal(canBorrow(1, 1), false);
});

test("rating increases for an on-time return in unchanged condition", () => {
  assert.equal(ratingDelta(false, true), 1);
});

test("rating loses ten points for each return fault", () => {
  assert.equal(ratingDelta(true, true), -10);
  assert.equal(ratingDelta(false, false), -10);
  assert.equal(ratingDelta(true, false), -20);
});
