CREATE DATABASE reservations;
GRANT ALL PRIVILEGES ON DATABASE reservations TO program;
CREATE DATABASE libraries;
GRANT ALL PRIVILEGES ON DATABASE libraries TO program;
CREATE DATABASE ratings;
GRANT ALL PRIVILEGES ON DATABASE ratings TO program;
\connect reservations
CREATE TABLE reservation (
  id SERIAL PRIMARY KEY,
  reservation_uid UUID UNIQUE NOT NULL,
  username VARCHAR(80) NOT NULL,
  book_uid UUID NOT NULL,
  library_uid UUID NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('RENTED','RETURNED','EXPIRED')),
  start_date DATE NOT NULL,
  till_date DATE NOT NULL,
  return_date DATE,
  return_condition VARCHAR(20),
  rented_condition VARCHAR(20) NOT NULL CHECK (rented_condition IN ('EXCELLENT','GOOD','BAD'))
);
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO program;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO program;
\connect libraries
CREATE TABLE library (
  id SERIAL PRIMARY KEY,
  library_uid UUID UNIQUE NOT NULL,
  name VARCHAR(80) NOT NULL,
  city VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL
);
CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  book_uid UUID UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  author VARCHAR(255), genre VARCHAR(255),
  condition VARCHAR(20) NOT NULL DEFAULT 'EXCELLENT' CHECK (condition IN ('EXCELLENT','GOOD','BAD'))
);
CREATE TABLE library_books (
  book_id INT REFERENCES books(id),
  library_id INT REFERENCES library(id),
  available_count INT NOT NULL CHECK (available_count >= 0),
  PRIMARY KEY (book_id, library_id)
);
INSERT INTO library (id, library_uid, name, city, address) VALUES
(1, '83575e12-7ce0-48ee-9931-51919ff3c9ee', 'Библиотека имени 7 Непьющих', 'Москва', '2-я Бауманская ул., д.5, стр.1');
INSERT INTO books (id, book_uid, name, author, genre, condition) VALUES
(1, 'f7cdc58f-2caf-4b15-9727-f89dcc629b27', 'Краткий курс C++ в 7 томах', 'Бьерн Страуструп', 'Научная фантастика', 'EXCELLENT');
INSERT INTO library_books (book_id, library_id, available_count) VALUES (1, 1, 1);
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO program;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO program;
\connect ratings
CREATE TABLE rating (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  stars INT NOT NULL CHECK (stars BETWEEN 1 AND 100)
);
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO program;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO program;

-- Local idempotency receipts, not a retry queue: the queue lives in Gateway memory.
\connect libraries
CREATE TABLE operation_receipt (operation_key TEXT PRIMARY KEY, result JSONB NOT NULL);
GRANT ALL PRIVILEGES ON operation_receipt TO program;
\connect ratings
CREATE TABLE operation_receipt (operation_key TEXT PRIMARY KEY, result JSONB NOT NULL);
GRANT ALL PRIVILEGES ON operation_receipt TO program;
\connect reservations
CREATE TABLE cancelled_reservation (reservation_uid UUID PRIMARY KEY);
GRANT ALL PRIVILEGES ON cancelled_reservation TO program;
