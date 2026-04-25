CREATE TABLE hx_passes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_token      text UNIQUE NOT NULL,
  form_id         text NOT NULL,
  form_slug       text NOT NULL,
  submission_id   text NOT NULL,
  sheet_row       integer,
  attendee_name   text,
  attendee_email  text,
  submission_data jsonb NOT NULL DEFAULT '{}',
  pass_config     jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'valid',
  scan_count      integer NOT NULL DEFAULT 0,
  checked_in_at   timestamptz,
  checked_in_by   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hx_passes_token   ON hx_passes(pass_token);
CREATE INDEX idx_hx_passes_form_id ON hx_passes(form_id);
CREATE INDEX idx_hx_passes_status  ON hx_passes(status);
