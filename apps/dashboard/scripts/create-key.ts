// Until sign-in exists (10d3): `npm run create-key "My agent"` makes a project and prints its ingestion key.
import { connect } from '../src/db/connect.ts';
import { createProjectWithKey } from '../src/ingest/keys.ts';

const name = process.argv[2]?.trim();
const url = process.env.DATABASE_URL;
if (!name || !url) {
  console.error('Usage: DATABASE_URL=postgres://... npm run create-key "<project name>"');
  process.exit(1);
}

const { db, close } = connect(url);
try {
  const { projectId, key } = await createProjectWithKey(db, name);
  console.log(`Project ${projectId} created.`);
  console.log(`TEXTAGENT_KEY=${key}`);
  console.log('Put it in the agent’s .env now; it is not stored and cannot be shown again.');
} finally {
  await close();
}
