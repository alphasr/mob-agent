import { sharedDb } from '../../../../src/db/connect.ts';
import { handlePrune } from '../../../../src/retention.ts';

export async function GET(request: Request): Promise<Response> {
  return handlePrune(request, sharedDb(), { secret: process.env.CRON_SECRET });
}
