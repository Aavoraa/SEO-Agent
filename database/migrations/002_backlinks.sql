-- Backlink monitoring: links from other websites to the project's site.
-- Sources: a CSV import (Search Console "Links" export, Ahrefs/Semrush/etc.) or the DataForSEO API.
-- The agent only MONITORS links and proposes fixes on our own site (e.g. 301s for broken link targets);
-- it never contacts third-party sites or builds links on its own.

CREATE TABLE backlinks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_url        text NOT NULL,
  source_domain     text NOT NULL,
  -- '' when the source only tells us "this page links to the site" (e.g. GSC "Latest links" export).
  target_url        text NOT NULL DEFAULT '',
  anchor            text,
  nofollow          boolean,
  origin            text NOT NULL DEFAULT 'import' CHECK (origin IN ('import','dataforseo','manual','demo')),
  status            text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','live','lost','error')),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- Result of the last live check of the linking page.
  last_checked_at   timestamptz,
  check_error       text,
  found_anchor      text,
  found_nofollow    boolean,
  lost_at           timestamptz,
  -- Result of the last check of the target page on OUR site.
  target_status     integer,
  target_final_url  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_url, target_url)
);
CREATE INDEX backlinks_project_status_idx ON backlinks(project_id, status);
CREATE INDEX backlinks_project_domain_idx ON backlinks(project_id, source_domain);
CREATE INDEX backlinks_checked_idx ON backlinks(project_id, last_checked_at NULLS FIRST);

ALTER TABLE recommendations DROP CONSTRAINT recommendations_source_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_source_check CHECK (source IN ('rule','ai','keyword','internal_linking','local','content','migration','competitor','backlinks','manual'));
