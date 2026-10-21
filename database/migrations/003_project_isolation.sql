-- Multi-client project isolation.
-- Platform admins (users.role = 'admin') see every project. Everyone else only sees projects they are a
-- member of, with the membership's role for that project. API keys can be scoped to one project.

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

ALTER TABLE api_keys ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;

-- Existing single-site installs: keep current editors/viewers working on the projects that already exist.
INSERT INTO project_members(project_id, user_id, role)
SELECT p.id, u.id, u.role FROM projects p CROSS JOIN users u WHERE u.role <> 'admin'
ON CONFLICT DO NOTHING;
