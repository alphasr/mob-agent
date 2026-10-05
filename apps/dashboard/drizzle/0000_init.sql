CREATE TABLE "ingest_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ingest_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"project_id" uuid NOT NULL,
	"id" text NOT NULL,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text NOT NULL,
	"sender_id" text,
	"text" text NOT NULL,
	"attachments" integer,
	"at" timestamp with time zone NOT NULL,
	"proactive" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_project_id_channel_id_direction_pk" PRIMARY KEY("project_id","channel","id","direction"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('in', 'out'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"project_id" uuid NOT NULL,
	"id" text NOT NULL,
	"conversation" text NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"sent_count" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"unpriced_models" text[],
	"dropped_spans" integer,
	"error" text,
	"message_ids" text[] NOT NULL,
	"spans" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traces_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "ingest_keys" ADD CONSTRAINT "ingest_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_keys_project_idx" ON "ingest_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_project_thread_idx" ON "messages" USING btree ("project_id","thread_id","at");--> statement-breakpoint
CREATE INDEX "traces_project_started_idx" ON "traces" USING btree ("project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_project_conversation_idx" ON "traces" USING btree ("project_id","conversation","started_at");