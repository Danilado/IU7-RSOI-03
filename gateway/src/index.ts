import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { canBorrow, ratingDelta } from "./rules";
import { CircuitBreaker, RetryQueue, ServiceUnavailable } from "./resilience";
import { randomUUID } from "node:crypto";

interface ServiceUrls {
  library: string;
  reservation: string;
  rating: string;
}

interface ApiError extends Error {
  status?: number;
  payload?: unknown;
}

interface BookLibrary {
  bookUid: string;
  name: string;
  author: string | null;
  genre: string | null;
  condition: string;
  libraryUid: string;
  libraryName: string;
  city: string;
  address: string;
  availableCount: number;
}

interface Reservation {
  reservationUid: string;
  username: string;
  bookUid: string;
  libraryUid: string;
  status: string;
  startDate: string;
  tillDate: string;
  rentedCondition: string;
  returnDate?: string;
  returnCondition?: string;
}

interface Rating {
  stars: number;
}

interface ReservationRequest {
  bookUid: string;
  libraryUid: string;
  tillDate: string;
}

interface ReturnRequest {
  condition: string;
  date: string;
}

export const app = express();
app.use(express.json());

const urls: ServiceUrls = {
  library: process.env.LIBRARY_URL ?? "http://library-service:8060",
  reservation: process.env.RESERVATION_URL ?? "http://reservation-service:8070",
  rating: process.env.RATING_URL ?? "http://rating-service:8050",
};

const breakers = new Map<string, CircuitBreaker>();
export const retryQueue = new RetryQueue(
  Number(process.env.RETRY_INTERVAL_MS) || 10_000,
);

async function call<T>(url: string, options: RequestInit = {}): Promise<T> {
  const service =
    Object.entries(urls).find(([, base]) => url.startsWith(`${base}/`))?.[0] ??
    "reservation";
  const operation = async (): Promise<T> => {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(
          Number(process.env.REQUEST_TIMEOUT_MS) || 2000,
        ),
        headers: { "content-type": "application/json", ...options.headers },
      });
      const data: unknown =
        response.status === 204
          ? null
          : await response.json().catch(() => null);
      if (response.status >= 500) throw new ServiceUnavailable(service);
      if (!response.ok) {
        const error: ApiError = new Error(
          (data as { message?: string } | null)?.message ??
            "Upstream request failed",
        );
        error.status = response.status;
        error.payload = data;
        throw error;
      }
      return data as T;
    } catch (error) {
      if ((error as ApiError).status) throw error;
      throw new ServiceUnavailable(service);
    }
  };
  if ((options.method ?? "GET") !== "GET") return operation();
  let breaker = breakers.get(service);
  if (!breaker) {
    breaker = new CircuitBreaker(
      Number(process.env.CB_FAILURE_THRESHOLD) || 3,
      Number(process.env.CB_RESET_MS) || 3000,
    );
    breakers.set(service, breaker);
  }
  return breaker.execute(operation, () => new ServiceUnavailable(service));
}

function query(
  values: Record<string, string | number | boolean | undefined>,
): string {
  return new URLSearchParams(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

function username(request: {
  get(name: string): string | undefined;
}): string | undefined {
  return request.get("X-User-Name");
}

function queryString(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

app.get("/manage/health", (_request, response) => response.sendStatus(200));

app.get("/api/v1/libraries", async (request, response, next) => {
  try {
    const city = queryString(request, "city");
    if (!city) {
      return response.status(400).json({ message: "city is required" });
    }

    const params = query({
      city,
      page: queryString(request, "page") ?? "1",
      size: queryString(request, "size") ?? "10",
    });
    const result = await call<unknown>(
      `${urls.library}/internal/libraries?${params}`,
    );
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/libraries/:uid/books", async (request, response, next) => {
  try {
    const params = query({
      page: queryString(request, "page") ?? "1",
      size: queryString(request, "size") ?? "25",
      showAll: queryString(request, "showAll") ?? false,
    });
    const result = await call<unknown>(
      `${urls.library}/internal/libraries/${request.params.uid}/books?${params}`,
    );
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/rating", async (request, response, next) => {
  try {
    const user = username(request);
    if (!user) {
      return response.status(400).json({ message: "X-User-Name is required" });
    }

    const rating = await call<Rating>(
      `${urls.rating}/internal/rating/${encodeURIComponent(user)}`,
    );
    return response.json(rating);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/reservations", async (request, response, next) => {
  try {
    const user = username(request);
    if (!user) {
      return response.status(400).json({ message: "X-User-Name is required" });
    }

    const reservations = await call<Reservation[]>(
      `${urls.reservation}/internal/reservations?username=${encodeURIComponent(user)}`,
    );
    const result = await Promise.all(
      reservations.map(async (reservation) => {
        let book: BookLibrary;
        try {
          book = await call<BookLibrary>(
            `${urls.library}/internal/books/${reservation.bookUid}/libraries/${reservation.libraryUid}`,
          );
        } catch (error) {
          if (!(error instanceof ServiceUnavailable)) throw error;
          return {
            reservationUid: reservation.reservationUid,
            status: reservation.status,
            startDate: reservation.startDate,
            tillDate: reservation.tillDate,
            book: { bookUid: reservation.bookUid },
            library: { libraryUid: reservation.libraryUid },
          };
        }
        return {
          reservationUid: reservation.reservationUid,
          status: reservation.status,
          startDate: reservation.startDate,
          tillDate: reservation.tillDate,
          book: {
            bookUid: book.bookUid,
            name: book.name,
            author: book.author,
            genre: book.genre,
          },
          library: {
            libraryUid: book.libraryUid,
            name: book.libraryName,
            address: book.address,
            city: book.city,
          },
        };
      }),
    );
    return response.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/v1/reservations",
  async (
    request: Request<object, unknown, ReservationRequest>,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const user = username(request);
      const { bookUid, libraryUid, tillDate } = request.body ?? {};
      if (!user || !bookUid || !libraryUid || !tillDate) {
        return response.status(400).json({
          message: "X-User-Name, bookUid, libraryUid and tillDate are required",
        });
      }

      const active = await call<Reservation[]>(
        `${urls.reservation}/internal/reservations?username=${encodeURIComponent(user)}`,
      );
      const rating = await call<Rating>(
        `${urls.rating}/internal/rating/${encodeURIComponent(user)}`,
      );
      if (!canBorrow(active.length, rating.stars)) {
        return response
          .status(400)
          .json({ message: "Active reservation limit reached" });
      }

      const book = await call<BookLibrary>(
        `${urls.library}/internal/books/${bookUid}/libraries/${libraryUid}`,
      );
      if (book.availableCount < 1) {
        return response.status(409).json({ message: "Book is unavailable" });
      }
      const reservationUid = randomUUID();
      let reservation: Reservation;
      try {
        reservation = await call<Reservation>(
          `${urls.reservation}/internal/reservations`,
          {
            method: "POST",
            body: JSON.stringify({
              reservationUid,
              username: user,
              bookUid,
              libraryUid,
              tillDate,
              condition: book.condition,
            }),
          },
        );
        await call<unknown>(
          `${urls.library}/internal/books/${bookUid}/libraries/${libraryUid}/checkout`,
          {
            method: "POST",
            headers: { "Idempotency-Key": reservationUid },
          },
        );
      } catch (error) {
        // Cancel an uncertain checkout too: its response may have been lost after commit.
        await retryQueue.submit(`rollback:${reservationUid}`, [
          () =>
            call(
              `${urls.reservation}/internal/reservations/${reservationUid}?username=${encodeURIComponent(user)}`,
              { method: "DELETE" },
            ),
          () =>
            call(
              `${urls.library}/internal/books/${bookUid}/libraries/${libraryUid}/checkout/cancel`,
              {
                method: "POST",
                headers: { "Idempotency-Key": reservationUid },
              },
            ),
        ]);
        throw error;
      }

      return response.json({
        reservationUid: reservation.reservationUid,
        status: reservation.status,
        startDate: reservation.startDate,
        tillDate: reservation.tillDate,
        book: {
          bookUid: book.bookUid,
          name: book.name,
          author: book.author,
          genre: book.genre,
        },
        library: {
          libraryUid: book.libraryUid,
          name: book.libraryName,
          address: book.address,
          city: book.city,
        },
        rating,
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.post(
  "/api/v1/reservations/:uid/return",
  async (
    request: Request<{ uid: string }, unknown, ReturnRequest>,
    response: Response,
    next: NextFunction,
  ) => {
    try {
      const user = username(request);
      const { condition, date } = request.body ?? {};
      if (!user || !condition || !date) {
        return response.status(400).json({
          message: "X-User-Name, condition and date are required",
        });
      }

      const reservation = await call<Reservation>(
        `${urls.reservation}/internal/reservations/${request.params.uid}/return`,
        {
          method: "POST",
          body: JSON.stringify({ username: user, date, condition }),
        },
      );
      const isLate =
        new Date(reservation.returnDate ?? date) >
        new Date(reservation.tillDate);
      const delta = ratingDelta(
        isLate,
        (reservation.returnCondition ?? condition) ===
          reservation.rentedCondition,
      );
      await retryQueue.submit(`return:${reservation.reservationUid}`, [
        () =>
          call(
            `${urls.library}/internal/books/${reservation.bookUid}/libraries/${reservation.libraryUid}/return`,
            {
              method: "POST",
              headers: { "Idempotency-Key": reservation.reservationUid },
            },
          ),
        () =>
          call(
            `${urls.rating}/internal/rating/${encodeURIComponent(user)}/change`,
            {
              method: "POST",
              headers: { "Idempotency-Key": reservation.reservationUid },
              body: JSON.stringify({ delta }),
            },
          ),
      ]);
      return response.sendStatus(204);
    } catch (error) {
      return next(error);
    }
  },
);

app.use(
  (
    error: ApiError,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    console.error(error);
    return response
      .status(error.status ?? 500)
      .json(
        error.payload ?? { message: error.message ?? "Internal server error" },
      );
  },
);

if (require.main === module)
  app.listen(Number(process.env.PORT) || 8080, "0.0.0.0");
