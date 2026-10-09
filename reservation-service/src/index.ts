import express from "express";
import { randomUUID } from "node:crypto";
import { Pool, types } from "pg";

types.setTypeParser(1082, (value: string) => value);

interface CreateReservationRequest {
  reservationUid: string;
  username: string;
  bookUid: string;
  libraryUid: string;
  tillDate: string;
  condition: string;
}

interface ReturnReservationRequest {
  username: string;
  date: string;
  condition: string;
}

const app = express();

app.use(express.json());
const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/manage/health", (_request, response) => response.sendStatus(200));

app.get("/internal/reservations", async (request, response, next) => {
  try {
    const result = await db.query(
      `SELECT reservation_uid AS "reservationUid", username,
        book_uid AS "bookUid", library_uid AS "libraryUid", status,
        start_date AS "startDate", till_date AS "tillDate",
        rented_condition AS "rentedCondition"
       FROM reservation WHERE username=$1 AND status=$2 ORDER BY id`,
      [request.query.username, request.query.status || "RENTED"],
    );
    return response.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

app.get("/internal/reservations/:uid", async (request, response, next) => {
  try {
    const result = await db.query(
      `SELECT reservation_uid AS "reservationUid", username,
        book_uid AS "bookUid", library_uid AS "libraryUid", status,
        start_date AS "startDate", till_date AS "tillDate",
        rented_condition AS "rentedCondition"
       FROM reservation WHERE reservation_uid=$1 AND username=$2`,
      [request.params.uid, request.query.username],
    );
    if (!result.rowCount) {
      return response.status(404).json({ message: "Reservation not found" });
    }
    return response.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/internal/reservations",
  async (
    request: express.Request<object, unknown, CreateReservationRequest>,
    response,
    next,
  ) => {
    try {
      const {
        reservationUid = randomUUID(),
        username,
        bookUid,
        libraryUid,
        tillDate,
        condition,
      } = request.body;
      const connection = await db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [reservationUid],
        );
        const cancelled = await connection.query(
          "SELECT 1 FROM cancelled_reservation WHERE reservation_uid=$1",
          [reservationUid],
        );
        if (cancelled.rowCount) {
          await connection.query("ROLLBACK");
          return response
            .status(409)
            .json({ message: "Reservation was cancelled" });
        }
        const result = await connection.query(
          `INSERT INTO reservation(
          reservation_uid, username, book_uid, library_uid, status,
          start_date, till_date, rented_condition
        ) VALUES($1, $2, $3, $4, 'RENTED', CURRENT_DATE, $5, $6)
        ON CONFLICT(reservation_uid) DO UPDATE SET reservation_uid=EXCLUDED.reservation_uid
        RETURNING reservation_uid AS "reservationUid", username,
          book_uid AS "bookUid", library_uid AS "libraryUid", status,
          start_date AS "startDate", till_date AS "tillDate",
          rented_condition AS "rentedCondition"`,
          [reservationUid, username, bookUid, libraryUid, tillDate, condition],
        );
        await connection.query("COMMIT");
        return response.status(201).json(result.rows[0]);
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      return next(error);
    }
  },
);

app.post(
  "/internal/reservations/:uid/return",
  async (
    request: express.Request<
      { uid: string },
      unknown,
      ReturnReservationRequest
    >,
    response,
    next,
  ) => {
    try {
      const { username, date, condition } = request.body;
      const result = await db.query(
        `UPDATE reservation
         SET status=CASE WHEN $1::date > till_date THEN 'EXPIRED' ELSE 'RETURNED' END,
             return_date=$1::date, return_condition=$4
         WHERE reservation_uid=$2 AND username=$3 AND status='RENTED'
         RETURNING reservation_uid AS "reservationUid", username,
          book_uid AS "bookUid", library_uid AS "libraryUid", status,
          start_date AS "startDate", till_date AS "tillDate",
          rented_condition AS "rentedCondition", $1::date AS "returnDate",
          $4::text AS "returnCondition"`,
        [date, request.params.uid, username, condition],
      );
      if (!result.rowCount) {
        const existing = await db.query(
          `SELECT reservation_uid AS "reservationUid", username, book_uid AS "bookUid", library_uid AS "libraryUid",
            status, start_date AS "startDate", till_date AS "tillDate", rented_condition AS "rentedCondition",
            return_date AS "returnDate", return_condition AS "returnCondition"
           FROM reservation WHERE reservation_uid=$1 AND username=$2 AND status IN ('RETURNED', 'EXPIRED')`,
          [request.params.uid, username],
        );
        if (existing.rowCount) return response.json(existing.rows[0]);
        return response.status(404).json({ message: "Reservation not found" });
      }
      return response.json(result.rows[0]);
    } catch (error) {
      return next(error);
    }
  },
);

app.delete("/internal/reservations/:uid", async (request, response, next) => {
  const connection = await db.connect().catch(next);
  if (!connection) return;
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [request.params.uid],
    );
    await connection.query(
      "INSERT INTO cancelled_reservation(reservation_uid) VALUES($1) ON CONFLICT DO NOTHING",
      [request.params.uid],
    );
    await connection.query(
      "DELETE FROM reservation WHERE reservation_uid=$1 AND username=$2 AND status='RENTED'",
      [request.params.uid, request.query.username],
    );
    await connection.query("COMMIT");
    return response.sendStatus(204);
  } catch (error) {
    await connection.query("ROLLBACK");
    return next(error);
  } finally {
    connection.release();
  }
});

app.use(
  (
    error: Error,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);
    return response.status(500).json({ message: "Internal server error" });
  },
);

app.listen(Number(process.env.PORT) || 8070, "0.0.0.0");
