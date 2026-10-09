#!/usr/bin/env python3
"""Additional end-to-end checks against the running Docker Compose stack."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
BOOK = "f7cdc58f-2caf-4b15-9727-f89dcc629b27"
LIBRARY = "83575e12-7ce0-48ee-9931-51919ff3c9ee"
USER = f"fault-test-{uuid.uuid4().hex[:12]}"
BOOK_PATH = f"/internal/books/{BOOK}/libraries/{LIBRARY}"


def compose(*args):
    return subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout


def request(port, path, body=None, method=None, key=None):
    headers = {"X-User-Name": USER, "Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(f"http://localhost:{port}{urllib.parse.quote(path, safe='/?:=&%')}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=6)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if raw and raw[:1] in (b"{", b"[") else None


def wait_for(predicate, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise AssertionError("Recovery did not finish within timeout")


def stock():
    return request(8060, BOOK_PATH)[1]["availableCount"]


def rating():
    return request(8050, f"/internal/rating/{USER}")[1]["stars"]


def sql(statement):
    return compose("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "libraries", "-v", "ON_ERROR_STOP=1", "-c", statement)


def run():
    assert stock() == 1
    code, reservation = request(8080, "/api/v1/reservations", {
        "bookUid": BOOK, "libraryUid": LIBRARY, "tillDate": "2099-12-31"})
    assert code == 200, (code, reservation)
    uid = reservation["reservationUid"]
    assert stock() == 0
    compose("stop", "library-service")
    code, items = request(8080, "/api/v1/reservations")
    assert code == 200
    assert items[0]["book"] == {"bookUid": BOOK}
    assert items[0]["library"] == {"libraryUid": LIBRARY}
    for _ in range(4):
        assert request(8080, "/api/v1/libraries?city=Москва")[0] == 503
        assert request(8080, f"/api/v1/libraries/{LIBRARY}/books")[0] == 503
    print("PASS: Library outage, UID fallback, critical reads and open circuit", flush=True)

    compose("stop", "rating-service")
    return_path = f"/api/v1/reservations/{uid}/return"
    assert request(8080, return_path, {"condition": "EXCELLENT", "date": "2026-10-08"})[0] == 204
    assert request(8070, f"/internal/reservations/{uid}?username={USER}")[1]["status"] == "RETURNED"
    compose("start", "library-service")
    wait_for(lambda: stock() == 1)
    # While Rating remains stopped, the library step has already completed.
    compose("start", "rating-service")
    wait_for(lambda: rating() == 2)
    wait_for(lambda: request(8080, "/api/v1/libraries?city=Москва")[0] == 200)
    print("PASS: return acknowledged during outage, ordered recovery and circuit reset", flush=True)

    assert request(8080, return_path, {"condition": "BAD", "date": "2100-01-01"})[0] == 204
    assert stock() == 1 and rating() == 2
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: request(8060, BOOK_PATH + "/return", {}, key=uid)[0], range(8)))
    assert results == [200] * 8
    assert request(8050, f"/internal/rating/{USER}/change", {"delta": 99}, key=uid)[0] == 200
    assert stock() == 1 and rating() == 2
    print("PASS: repeated return and concurrent delivery never duplicate stock/rating changes", flush=True)

    sql("""CREATE FUNCTION fail_checkout_test() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected checkout failure'; END $$;
         CREATE TRIGGER fail_checkout_test BEFORE UPDATE ON library_books
         FOR EACH ROW WHEN (NEW.available_count < OLD.available_count)
         EXECUTE FUNCTION fail_checkout_test();""")
    try:
        code, _ = request(8080, "/api/v1/reservations", {
            "bookUid": BOOK, "libraryUid": LIBRARY, "tillDate": "2099-12-31"})
        assert code == 503
        assert request(8070, f"/internal/reservations?username={USER}")[1] == []
        assert stock() == 1
    finally:
        sql("DROP TRIGGER IF EXISTS fail_checkout_test ON library_books; DROP FUNCTION IF EXISTS fail_checkout_test();")
    print("PASS: failed checkout rolls back the created reservation", flush=True)

    cancelled = str(uuid.uuid4())
    assert request(8070, f"/internal/reservations/{cancelled}?username={USER}", method="DELETE")[0] == 204
    assert request(8070, "/internal/reservations", {"reservationUid": cancelled, "username": USER,
        "bookUid": BOOK, "libraryUid": LIBRARY, "tillDate": "2099-12-31", "condition": "EXCELLENT"})[0] == 409
    assert request(8060, BOOK_PATH + "/checkout/cancel", {}, key=cancelled)[0] == 204
    assert request(8060, BOOK_PATH + "/checkout", {}, key=cancelled)[0] == 409
    assert stock() == 1
    print("PASS: cancellation blocks delayed creation and checkout", flush=True)


if __name__ == "__main__":
    try:
        run()
    finally:
        # Restore services even after an assertion failure.
        compose("start", "library-service", "rating-service")
