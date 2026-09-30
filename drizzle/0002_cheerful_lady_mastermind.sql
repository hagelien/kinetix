CREATE TABLE "citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"drug_id" integer,
	"type" varchar(10) NOT NULL,
	"identifier" text NOT NULL,
	"metadata" jsonb,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drug_parameter_revisions" ADD COLUMN "reference_id" integer;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_drug_id_drugs_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drugs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citations_drug_id_idx" ON "citations" USING btree ("drug_id");--> statement-breakpoint
CREATE UNIQUE INDEX "citations_type_identifier_idx" ON "citations" USING btree ("type","identifier");--> statement-breakpoint
ALTER TABLE "drug_parameter_revisions" ADD CONSTRAINT "drug_parameter_revisions_reference_id_citations_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."citations"("id") ON DELETE set null ON UPDATE no action;
