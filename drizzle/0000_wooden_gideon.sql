CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wiki_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"description" text,
	CONSTRAINT "wiki_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "wiki_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "wiki_page_categories" (
	"page_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	CONSTRAINT "wiki_page_categories_page_id_category_id_pk" PRIMARY KEY("page_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(300) NOT NULL,
	"title" varchar(500) NOT NULL,
	"content" jsonb,
	"content_html" text,
	"content_plaintext" text,
	"page_type" varchar(30) DEFAULT 'topic' NOT NULL,
	"drug_cid" integer,
	"parent_id" integer,
	"status" varchar(20) DEFAULT 'published' NOT NULL,
	"created_by" integer NOT NULL,
	"updated_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "wiki_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_html" text,
	"edit_summary" varchar(500),
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_page_categories" ADD CONSTRAINT "wiki_page_categories_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_categories" ADD CONSTRAINT "wiki_page_categories_category_id_wiki_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."wiki_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_pages_drug_cid_idx" ON "wiki_pages" USING btree ("drug_cid");--> statement-breakpoint
CREATE INDEX "wiki_pages_page_type_idx" ON "wiki_pages" USING btree ("page_type");--> statement-breakpoint
CREATE INDEX "wiki_pages_status_idx" ON "wiki_pages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wiki_revisions_page_created_idx" ON "wiki_revisions" USING btree ("page_id","created_at");