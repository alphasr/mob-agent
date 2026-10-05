import { toNextJsHandler } from 'better-auth/next-js';
import { sharedAuth } from '../../../../src/auth/auth.ts';

export const { GET, POST } = toNextJsHandler((request) => sharedAuth().handler(request));
