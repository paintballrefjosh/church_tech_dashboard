CREATE TABLE IF NOT EXISTS "live_search_docs" (
	"kind" text NOT NULL,
	"doc_id" text NOT NULL,
	"rev" text NOT NULL,
	"doc" jsonb NOT NULL,
	CONSTRAINT "live_search_docs_kind_doc_id_pk" PRIMARY KEY("kind","doc_id")
);
