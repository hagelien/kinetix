// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runInPoolTransaction must not let a dropped WebSocket connection become an
// uncaught exception. pg-pool stops listening for 'error' on a client while it
// is checked out, and EventEmitter throws on an 'error' event nobody listens
// for — in production that exited the function instance mid-request.

const pools: FakePool[] = [];

class FakePool extends EventEmitter {
  constructor() {
    super();
    pools.push(this);
  }
  async end() {}
}

let duringTransaction: (pool: FakePool) => void = () => {};

vi.mock("@neondatabase/serverless", () => ({
  Pool: FakePool,
  neon: vi.fn(),
  neonConfig: { webSocketConstructor: class {} },
}));

vi.mock("drizzle-orm/neon-serverless", () => ({
  drizzle: (pool: FakePool) => ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => {
      duringTransaction(pool);
      return cb({});
    },
  }),
}));

const { runInPoolTransaction } = await import("../api/_lib/db");

describe("runInPoolTransaction connection errors", () => {
  const originalUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://user:pass@example.invalid/db";
    pools.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
    duringTransaction = () => {};
    vi.restoreAllMocks();
  });

  it("listens for errors on checked-out clients", async () => {
    duringTransaction = (pool) => {
      const client = new EventEmitter();
      pool.emit("connect", client);
      // Without a listener this emit throws synchronously.
      client.emit("error", new Error("Connection terminated unexpectedly"));
    };
    await expect(runInPoolTransaction(async () => "done")).resolves.toBe("done");
    expect(console.error).toHaveBeenCalledWith(
      "[db] pool connection error: Connection terminated unexpectedly",
    );
  });

  it("listens for errors on idle clients", async () => {
    duringTransaction = (pool) => {
      pool.emit("error", new Error("server conn crashed?"));
    };
    await expect(runInPoolTransaction(async () => 1)).resolves.toBe(1);
    expect(pools).toHaveLength(1);
  });
});
