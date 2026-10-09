import express from "express";
import { Pool, types } from "pg";
import { once } from "./idempotency";

types.setTypeParser(1082, (value: string) => value);
const app = express();
app.use(express.json());
const db = new Pool({ connectionString: process.env.DATABASE_URL });

function queryString(
  request: express.Request,
  key: string,
): string | undefined {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

function pagination(request: express.Request, defaultSize: number) {
  const page = Math.max(1, Number(queryString(request, "page")) || 1);
  const size = Math.min(
    100,
    Math.max(1, Number(queryString(request, "size")) || defaultSize),
  );
  return { page, size, offset: (page - 1) * size };
}

app.get("/manage/health", (_request, response) => response.sendStatus(200));

app.get("/internal/libraries", async (request, response, next) => {
  try {
    const city = queryString(request, "city");
    const { page, size, offset } = pagination(request, 10);
    const [items, total] = await Promise.all([
      db.query(
        'SELECT library_uid AS "libraryUid", name, address, city FROM library WHERE city=$1 ORDER BY id LIMIT $2 OFFSET $3',
        [city, size, offset],
      ),
      db.query("SELECT count(*) FROM library WHERE city=$1", [city]),
    ]);
    return response.json({
      page,
      pageSize: items.rowCount,
      totalElements: Number(total.rows[0].count),
      items: items.rows,
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/internal/libraries/:uid/books", async (request, response, next) => {
  try {
    const { page, size, offset } = pagination(request, 25);
    const availabilityFilter =
      queryString(request, "showAll") === "true"
        ? ""
        : "AND lb.available_count > 0";
    const sql = `SELECT b.book_uid AS "bookUid", b.name, b.author, b.genre, b.condition, lb.available_count AS "availableCount"
      FROM library_books lb
      JOIN library l ON l.id=lb.library_id
      JOIN books b ON b.id=lb.book_id
      WHERE l.library_uid=$1 ${availabilityFilter}
      ORDER BY b.id`;
    const [items, total] = await Promise.all([
      db.query(`${sql} LIMIT $2 OFFSET $3`, [request.params.uid, size, offset]),
      db.query(
        `SELECT count(*) FROM library_books lb
          JOIN library l ON l.id=lb.library_id
          JOIN books b ON b.id=lb.book_id
          WHERE l.library_uid=$1 ${availabilityFilter}`,
        [request.params.uid],
      ),
    ]);
    return response.json({
      page,
      pageSize: items.rowCount,
      totalElements: Number(total.rows[0].count),
      items: items.rows,
    });
  } catch (error) {
    return next(error);
  }
});

app.get(
  "/internal/books/:bookUid/libraries/:libraryUid",
  async (request, response, next) => {
    try {
      const result = await db.query(
        `SELECT b.book_uid AS "bookUid", b.name, b.author, b.genre, b.condition,
        l.library_uid AS "libraryUid", l.name AS "libraryName", l.city, l.address,
        lb.available_count AS "availableCount"
       FROM library_books lb
       JOIN books b ON b.id=lb.book_id
       JOIN library l ON l.id=lb.library_id
       WHERE b.book_uid=$1 AND l.library_uid=$2`,
        [request.params.bookUid, request.params.libraryUid],
      );
      if (!result.rowCount) {
        return response
          .status(404)
          .json({ message: "Book or library not found" });
      }
      return response.json(result.rows[0]);
    } catch (error) {
      return next(error);
    }
  },
);

function failure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

app.post(
  "/internal/books/:bookUid/libraries/:libraryUid/checkout",
  async (request, response, next) => {
    try {
      const key = request.get("Idempotency-Key");
      if (!key)
        return response
          .status(400)
          .json({ message: "Idempotency-Key is required" });
      const result = await once(db, `checkout:${key}`, async (connection) => {
        const updated = await connection.query(
          `UPDATE library_books lb SET available_count=available_count-1
         FROM books b, library l
         WHERE lb.book_id=b.id AND lb.library_id=l.id
           AND b.book_uid=$1 AND l.library_uid=$2 AND lb.available_count>0
         RETURNING lb.available_count`,
          [request.params.bookUid, request.params.libraryUid],
        );
        if (!updated.rowCount) throw failure(409, "Book is unavailable");
        return {
          availableCount: updated.rows[0].available_count,
          cancelled: false,
        };
      });
      if (result.cancelled) throw failure(409, "Checkout was cancelled");
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

app.post(
  "/internal/books/:bookUid/libraries/:libraryUid/checkout/cancel",
  async (request, response, next) => {
    const connection = await db.connect().catch(next);
    if (!connection) return;
    try {
      const key = request.get("Idempotency-Key");
      if (!key)
        return response
          .status(400)
          .json({ message: "Idempotency-Key is required" });
      await connection.query("BEGIN");
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`checkout:${key}`],
      );
      const receipt = await connection.query(
        "SELECT result FROM operation_receipt WHERE operation_key=$1",
        [`checkout:${key}`],
      );
      if (receipt.rowCount && !receipt.rows[0].result.cancelled) {
        await connection.query(
          `UPDATE library_books lb SET available_count=available_count+1 FROM books b, library l
         WHERE lb.book_id=b.id AND lb.library_id=l.id AND b.book_uid=$1 AND l.library_uid=$2`,
          [request.params.bookUid, request.params.libraryUid],
        );
      }
      // Tombstone prevents a delayed checkout request from applying after cancellation.
      await connection.query(
        `INSERT INTO operation_receipt(operation_key, result) VALUES($1, '{"cancelled":true}')
       ON CONFLICT(operation_key) DO UPDATE SET result=EXCLUDED.result`,
        [`checkout:${key}`],
      );
      await connection.query("COMMIT");
      return response.sendStatus(204);
    } catch (error) {
      await connection.query("ROLLBACK");
      return next(error);
    } finally {
      connection.release();
    }
  },
);

app.post(
  "/internal/books/:bookUid/libraries/:libraryUid/return",
  async (request, response, next) => {
    try {
      const key = request.get("Idempotency-Key");
      if (!key)
        return response
          .status(400)
          .json({ message: "Idempotency-Key is required" });
      const result = await once(db, `return:${key}`, async (connection) => {
        const updated = await connection.query(
          `UPDATE library_books lb SET available_count=available_count+1 FROM books b, library l
         WHERE lb.book_id=b.id AND lb.library_id=l.id AND b.book_uid=$1 AND l.library_uid=$2
         RETURNING lb.available_count`,
          [request.params.bookUid, request.params.libraryUid],
        );
        if (!updated.rowCount) throw failure(404, "Book or library not found");
        return { availableCount: updated.rows[0].available_count };
      });
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

app.use(
  (
    error: Error & { status?: number },
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);
    return response
      .status(error.status ?? 500)
      .json({
        message: error.status ? error.message : "Internal server error",
      });
  },
);

app.listen(Number(process.env.PORT) || 8060, "0.0.0.0");
