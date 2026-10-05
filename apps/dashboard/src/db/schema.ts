import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ExportedSpan } from '@textagent/cloud';

/**
 * Every row below `projects` carries `project_id`, and every query must filter on it:
 * that is the only thing separating one customer's data from another's.
 * Ids that can name a person arrive hashed (see `parseBatch`); nothing here can reverse them.
 */

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Off: the ingest endpoint drops message text, and turning it off deletes what was stored. */
  storeText: boolean('store_text').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Keyed by GitHub's numeric user id (stable across username changes), which better-auth stores as
 * `auth_accounts.account_id`; someone added before they ever sign in is a member from their first sign-in.
 */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    githubId: text('github_id').notNull(),
    /** For display; may be out of date after a rename. */
    githubLogin: text('github_login').notNull(),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.githubId] }),
    index('project_members_github_idx').on(t.githubId),
    check('project_members_role_check', sql`${t.role} in ('owner', 'member')`),
  ],
);

export const ingestKeys = pgTable(
  'ingest_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** SHA-256 of the key, hex. The key itself is shown once and never stored. */
    keyHash: text('key_hash').notNull().unique(),
    /** The first characters, so people can tell their keys apart. */
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('ingest_keys_project_idx').on(t.projectId)],
);

export const traces = pgTable(
  'traces',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    conversation: text('conversation').notNull(),
    channel: text('channel').notNull(),
    threadId: text('thread_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    sentCount: integer('sent_count').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    unpricedModels: text('unpriced_models').array(),
    droppedSpans: integer('dropped_spans'),
    error: text('error'),
    messageIds: text('message_ids').array().notNull(),
    spans: jsonb('spans').$type<ExportedSpan[]>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exporter retries resend the same trace id; the insert does nothing the second time.
    primaryKey({ columns: [t.projectId, t.id] }),
    index('traces_project_started_idx').on(t.projectId, t.startedAt.desc()),
    index('traces_project_conversation_idx').on(t.projectId, t.conversation, t.startedAt),
    // Retention deletes by age across all projects.
    index('traces_started_idx').on(t.startedAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    channel: text('channel').notNull(),
    threadId: text('thread_id').notNull(),
    senderId: text('sender_id'),
    text: text('text').notNull(),
    attachments: integer('attachments'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    proactive: boolean('proactive').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ids are unique only within a channel, and a sent and a received one may coincide.
    primaryKey({ columns: [t.projectId, t.channel, t.id, t.direction] }),
    index('messages_project_thread_idx').on(t.projectId, t.threadId, t.at),
    index('messages_at_idx').on(t.at),
    check('messages_direction_check', sql`${t.direction} in ('in', 'out')`),
  ],
);

/*
 * better-auth's tables (GitHub sign-in). Property names must match better-auth's core schema
 * (@better-auth/core/db); the adapter maps them as { user: authUsers, session: authSessions, ... }.
 */

const authTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Our additional field (see auth.ts): the GitHub username, refreshed at each sign-in. */
  githubLogin: text('github_login'),
  ...authTimestamps,
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    ...authTimestamps,
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    /** For GitHub: the numeric user id, which `project_members.github_id` matches. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...authTimestamps,
  },
  (t) => [
    unique('auth_accounts_provider_account_unique').on(t.providerId, t.accountId),
    index('auth_accounts_user_idx').on(t.userId),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...authTimestamps,
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

/** Sign-in rate limits, in the database because serverless instances don't share memory. */
export const authRateLimits = pgTable('auth_rate_limits', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
