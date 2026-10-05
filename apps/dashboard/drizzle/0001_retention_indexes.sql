CREATE INDEX "messages_at_idx" ON "messages" USING btree ("at");--> statement-breakpoint
CREATE INDEX "traces_started_idx" ON "traces" USING btree ("started_at");