-- Heatmaps: first-party click + scroll collection (hm.js tracker) and Microsoft Clarity insights.
-- Privacy: no cookies, no IPs, no form values, no free text except link/button labels (public page content).

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check CHECK (provider IN ('google_search_console','google_analytics','google_oauth','website_deploy','microsoft_clarity'));

-- One row per page view (kind = 'view', max scroll depth updated in place) or per click (kind = 'click').
CREATE TABLE heatmap_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_path    text NOT NULL,
  page_title   text,
  kind         text NOT NULL CHECK (kind IN ('view','click')),
  device       text NOT NULL CHECK (device IN ('desktop','tablet','mobile')),
  view_id      text NOT NULL,              -- random per page load, never stored in the browser
  -- click position: element (CSS path) + offset inside it (0–1), plus document fallback (x 0–1, y px of doc_height)
  selector     text,
  label        text,
  rel_x        real,
  rel_y        real,
  x            real,
  y            integer,
  doc_height   integer,
  viewport_w   integer,
  viewport_h   integer,
  scroll_depth real,                       -- views: deepest point reached, 0–1 of the document
  rage         boolean NOT NULL DEFAULT false,
  dead         boolean NOT NULL DEFAULT false,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX heatmap_events_page_idx ON heatmap_events (project_id, page_path, created_at);
CREATE INDEX heatmap_events_created_idx ON heatmap_events (project_id, created_at);
CREATE UNIQUE INDEX heatmap_events_view_uniq ON heatmap_events (project_id, view_id) WHERE kind = 'view';

-- Raw Microsoft Clarity Data Export responses (the API allows 10 calls/project/day and 1–3 days of data).
CREATE TABLE clarity_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  num_days    integer NOT NULL,
  dimension   text NOT NULL,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clarity_snapshots_idx ON clarity_snapshots (project_id, fetched_at DESC);
