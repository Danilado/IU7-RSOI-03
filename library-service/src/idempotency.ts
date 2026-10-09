import { type Pool, type PoolClient } from "pg";

// Receipt and mutation commit together in this service's own database.
export async function once<T>(
  db: Pool,
  key: string,
  action: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
    const previous = await connection.query(
      "SELECT result FROM operation_receipt WHERE operation_key=$1",
      [key],
    );
    if (previous.rowCount) {
      await connection.query("COMMIT");
      return previous.rows[0].result as T;
    }
    const result = await action(connection);
    await connection.query(
      "INSERT INTO operation_receipt(operation_key, result) VALUES($1, $2::jsonb)",
      [key, JSON.stringify(result)],
    );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
