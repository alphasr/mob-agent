import { sharedDb } from '../../../src/db/connect.ts';
import { handleIngest } from '../../../src/ingest/handler.ts';

export async function POST(request: Request): Promise<Response> {
  return handleIngest(request, sharedDb());
}
