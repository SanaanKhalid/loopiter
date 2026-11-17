import { Pool } from 'pg';
import { FeedbackLoop } from '../src/index.js';
import { PostgresStore } from '../src/postgres.js';
const pool = new Pool({
  connectionString: process.env.LOOPITER_TEST_DATABASE_URL,
});
const loop = new FeedbackLoop({
  store: new PostgresStore(pool),
  namespace: process.argv[2]!,
});
try {
  await loop.completeExecution('race', { output: process.argv[3]! }, 1);
  console.log('updated');
} catch {
  process.exitCode = 2;
} finally {
  await pool.end();
}
