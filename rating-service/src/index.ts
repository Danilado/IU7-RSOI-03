import express from "express";
import { Pool } from "pg";
import { once } from "./idempotency";

interface ChangeRatingRequest {
  delta: number;
}

const app = express();
app.use(express.json());
const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/manage/health", (_request, response) => response.sendStatus(200));

app.get("/internal/rating/:username", async (request, response, next) => {
  try {
    const result = await db.query(
      `INSERT INTO rating(username, stars) VALUES($1, 1)
       ON CONFLICT(username) DO UPDATE SET username=EXCLUDED.username
       RETURNING stars`,
      [request.params.username],
    );
    return response.json({ stars: result.rows[0].stars });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/internal/rating/:username/change",
  async (
    request: express.Request<
      { username: string },
      unknown,
      ChangeRatingRequest
    >,
    response,
    next,
  ) => {
    try {
      const delta = Number(request.body.delta);
      if (!Number.isFinite(delta)) {
        return response.status(400).json({ message: "delta must be a number" });
      }
      const key = request.get("Idempotency-Key");
      if (!key)
        return response
          .status(400)
          .json({ message: "Idempotency-Key is required" });
      const result = await once(db, `rating:${key}`, async (connection) => {
        const updated = await connection.query(
          `INSERT INTO rating(username, stars)
         VALUES($1, GREATEST(1, LEAST(100, 1+$2)))
         ON CONFLICT(username) DO UPDATE
         SET stars=GREATEST(1, LEAST(100, rating.stars+$2))
         RETURNING stars`,
          [request.params.username, delta],
        );
        return { stars: updated.rows[0].stars };
      });
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

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

app.listen(Number(process.env.PORT) || 8050, "0.0.0.0");
