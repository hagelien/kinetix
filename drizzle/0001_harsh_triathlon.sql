CREATE TABLE "allowed_email_domains" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" varchar(253) NOT NULL,
	"added_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_email_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "allowed_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"added_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "analytical_method_components" (
	"method_id" integer NOT NULL,
	"drug_id" integer NOT NULL,
	CONSTRAINT "analytical_method_components_method_id_drug_id_pk" PRIMARY KEY("method_id","drug_id")
);
--> statement-breakpoint
CREATE TABLE "analytical_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(300) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "analytical_methods_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "drug_interactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"drug_id" integer NOT NULL,
	"user_id" integer,
	"event_type" varchar(30) NOT NULL,
	"ip_hash" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drug_parameter_discussions" (
	"id" serial PRIMARY KEY NOT NULL,
	"drug_id" integer NOT NULL,
	"parameter" varchar(60),
	"parent_id" integer,
	"body" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drug_parameter_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"drug_id" integer NOT NULL,
	"parameter" varchar(60) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"edit_summary" varchar(500),
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drugs" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(200) NOT NULL,
	"name" varchar(300) NOT NULL,
	"name_en" varchar(300),
	"pubchem_cid" integer,
	"category" varchar(100),
	"molecular_weight" numeric(10, 4),
	"half_life" jsonb,
	"volume_of_distribution" jsonb,
	"bioavailability" jsonb,
	"protein_binding" jsonb,
	"blood_plasma_ratio" jsonb,
	"postmortem_redistribution" jsonb,
	"metabolism" jsonb,
	"therapeutic_range" jsonb,
	"toxic_range" jsonb,
	"lethal_range" jsonb,
	"popularity_score" integer DEFAULT 0 NOT NULL,
	"search_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "drugs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "drugs_pubchem_cid_unique" UNIQUE("pubchem_cid")
);
--> statement-breakpoint
CREATE TABLE "simulator_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(500) NOT NULL,
	"case_data" jsonb NOT NULL,
	"created_by" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_auth_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_max_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "magic_link_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "magic_link_expires" timestamp;--> statement-breakpoint
ALTER TABLE "allowed_email_domains" ADD CONSTRAINT "allowed_email_domains_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowed_emails" ADD CONSTRAINT "allowed_emails_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD CONSTRAINT "analytical_method_components_method_id_analytical_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."analytical_methods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD CONSTRAINT "analytical_method_components_drug_id_drugs_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_interactions" ADD CONSTRAINT "drug_interactions_drug_id_drugs_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_interactions" ADD CONSTRAINT "drug_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_parameter_discussions" ADD CONSTRAINT "drug_parameter_discussions_drug_id_drugs_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_parameter_discussions" ADD CONSTRAINT "drug_parameter_discussions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_parameter_revisions" ADD CONSTRAINT "drug_parameter_revisions_drug_id_drugs_id_fk" FOREIGN KEY ("drug_id") REFERENCES "public"."drugs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_parameter_revisions" ADD CONSTRAINT "drug_parameter_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulator_cases" ADD CONSTRAINT "simulator_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drug_interactions_drug_created_idx" ON "drug_interactions" USING btree ("drug_id","created_at");--> statement-breakpoint
CREATE INDEX "drug_param_disc_drug_param_idx" ON "drug_parameter_discussions" USING btree ("drug_id","parameter");--> statement-breakpoint
CREATE INDEX "drug_param_rev_drug_param_idx" ON "drug_parameter_revisions" USING btree ("drug_id","parameter","created_at");--> statement-breakpoint
CREATE INDEX "drugs_slug_idx" ON "drugs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "drugs_pubchem_cid_idx" ON "drugs" USING btree ("pubchem_cid");--> statement-breakpoint
CREATE INDEX "drugs_popularity_idx" ON "drugs" USING btree ("popularity_score");--> statement-breakpoint
CREATE INDEX "drugs_search_key_idx" ON "drugs" USING btree ("search_key");--> statement-breakpoint
CREATE INDEX "simulator_cases_user_idx" ON "simulator_cases" USING btree ("created_by");