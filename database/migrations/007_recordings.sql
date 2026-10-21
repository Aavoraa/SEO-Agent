-- Session recordings (rrweb, loaded by the hm.js tracker when recordings are enabled for the project).
-- Privacy: every input is masked in the browser (optionally all text), [data-hm-block] elements are not
-- recorded, no IP address is stored, and recordings are deleted after RECORDING_RETENTION_DAYS.

CREATE TABLE session_recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_key   text NOT NULL,                 -- random id kept in the tab's sessionStorage (30 min idle timeout)
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz NOT NULL DEFAULT now(),
  first_ts      bigint,                        -- first/last rrweb event timestamps (client clock, ms)
  last_ts       bigint,
  duration_ms   integer NOT NULL DEFAULT 0,
  device        text NOT NULL CHECK (device IN ('desktop','tablet','mobile')),
  browser       text,
  os            text,
  country       text,
  viewport_w    integer,
  viewport_h    integer,
  entry_path    text NOT NULL,
  exit_path     text NOT NULL,
  pages         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{v, path, title, ts}]
  page_count    integer NOT NULL DEFAULT 1,
  click_count   integer NOT NULL DEFAULT 0,
  rage_clicks   integer NOT NULL DEFAULT 0,
  dead_clicks   integer NOT NULL DEFAULT 0,
  error_count   integer NOT NULL DEFAULT 0,
  event_count   integer NOT NULL DEFAULT 0,
  bytes         integer NOT NULL DEFAULT 0,
  is_demo       boolean NOT NULL DEFAULT false,
  favorite      boolean NOT NULL DEFAULT false,
  viewed_at     timestamptz,
  UNIQUE (project_id, session_key)
);
CREATE INDEX session_recordings_list_idx ON session_recordings (project_id, started_at DESC);

CREATE TABLE recording_chunks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recording_id  uuid NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  view_id       text NOT NULL,
  seq           integer NOT NULL,
  first_ts      bigint NOT NULL,
  last_ts       bigint NOT NULL,
  event_count   integer NOT NULL,
  data          text NOT NULL,                 -- gzip + base64 of the JSON event array
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recording_chunks_idx ON recording_chunks (recording_id, first_ts, seq);
