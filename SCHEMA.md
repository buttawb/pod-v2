# Schema, as deployed

Generated from the live database rather than from the migrations, so this is
what is actually there rather than what was intended. The device schema is read
from app/src/db/schema.ts.

## PostgreSQL (12 tables, the TypeORM migrations table omitted)

### stops

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `driver_id` | uuid | no |  |
| `address` | text | no |  |
| `postcode` | text | no |  |
| `location` | varchar | no |  |
| `sequence` | int | no |  |
| `created_at` | timestamptz | no | `now()` |
| `status` | text | no | `'pending'` |
| `latest_attempt_id` | uuid | yes |  |
| `lat` | float8 | yes |  |
| `lng` | float8 | yes |  |
| `updated_at` | timestamptz | no | `now()` |
| `expected_barcode` | text | yes |  |

Constraints:

- **CHECK** `chk_stops_status` - CHECK ((status = ANY (ARRAY['pending'::text, 'attempted'::text, 'delivered'::text, 'failed'::text])))
- **PRIMARY KEY** `stops_pkey` - PRIMARY KEY (id)

Indexes:

- `idx_stops_driver_day` - (driver_id, created_at DESC, sequence)
- `idx_stops_driver_updated` - (driver_id, updated_at, id)
- `idx_stops_geo` - (point(lng, lat)) WHERE (lat IS NOT NULL)

### delivery_attempts

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `client_attempt_id` | uuid | no |  |
| `stop_id` | uuid | no |  |
| `driver_id` | uuid | no |  |
| `device_id` | uuid | yes |  |
| `parcel_barcode` | text | yes |  |
| `barcode_source` | text | yes |  |
| `outcome` | text | no |  |
| `signature_s3_key` | text | yes |  |
| `signature_verified_at` | timestamptz | yes |  |
| `signature_size_bytes` | int8 | yes |  |
| `neighbour_house_number` | text | yes |  |
| `reason_code` | text | yes |  |
| `note` | text | yes |  |
| `lat` | float8 | yes |  |
| `lng` | float8 | yes |  |
| `gps_accuracy_m` | real | yes |  |
| `captured_at` | timestamptz | no |  |
| `received_at` | timestamptz | no | `now()` |
| `clock_suspect` | bool | no | `false` |
| `app_version` | text | no |  |
| `source` | text | no | `'v2'` |
| `raw_payload` | jsonb | yes |  |
| `declared_photo_count` | smallint | no | `0` |
| `evidence_status` | text | no | `'pending_media'` |
| `payload_hash` | text | no |  |
| `updated_at` | timestamptz | no | `now()` |
| `signature_declared_size_bytes` | int8 | yes |  |
| `conflict` | bool | no | `false` |
| `conflict_reason` | text | yes |  |
| `retry_today` | bool | no | `false` |
| `barcode_match` | bool | yes |  |
| `barcode_override_reason` | text | yes |  |

Constraints:

- **CHECK** `chk_attempts_barcode_source` - CHECK (((barcode_source IS NULL) OR (barcode_source = ANY (ARRAY['scanned'::text, 'manual'::text]))))
- **CHECK** `chk_attempts_evidence_status` - CHECK ((evidence_status = ANY (ARRAY['pending_media'::text, 'complete'::text, 'incomplete_expired'::text])))
- **CHECK** `chk_attempts_lat` - CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)))
- **CHECK** `chk_attempts_lng` - CHECK (((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision)))
- **CHECK** `chk_attempts_outcome` - CHECK ((outcome = ANY (ARRAY['delivered_to_person'::text, 'left_with_neighbour'::text, 'left_safe_place'::text, 'no_answer_carded'::text, 'refused'::text, 'access_failure'::text])))
- **CHECK** `chk_attempts_photo_count` - CHECK (((declared_photo_count >= 0) AND (declared_photo_count <= 4)))
- **CHECK** `chk_attempts_source` - CHECK ((source = ANY (ARRAY['v2'::text, 'v1_compat'::text, 'backfill'::text])))
- **CHECK** `chk_failure_reason` - CHECK (((outcome <> ALL (ARRAY['refused'::text, 'access_failure'::text])) OR (reason_code IS NOT NULL)))
- **CHECK** `chk_neighbour_evidence` - CHECK (((outcome <> 'left_with_neighbour'::text) OR (neighbour_house_number IS NOT NULL)))
- **FOREIGN KEY** `delivery_attempts_device_id_fkey` - FOREIGN KEY (device_id) REFERENCES devices(id)
- **FOREIGN KEY** `delivery_attempts_driver_id_fkey` - FOREIGN KEY (driver_id) REFERENCES drivers(id)
- **FOREIGN KEY** `delivery_attempts_stop_id_fkey` - FOREIGN KEY (stop_id) REFERENCES stops(id)
- **PRIMARY KEY** `delivery_attempts_pkey` - PRIMARY KEY (id)

Indexes:

- `idx_attempts_conflict` - (received_at DESC, id DESC) WHERE conflict
- `idx_attempts_driver_updated` - (driver_id, updated_at, id)
- `idx_attempts_pending_media` - (updated_at) WHERE (evidence_status = 'pending_media'::text)
- `idx_attempts_received` - (received_at DESC, id)
- `idx_attempts_retry_today` - (stop_id, received_at DESC) WHERE retry_today
- `idx_attempts_stop` - (stop_id, captured_at DESC)
- `uq_attempts_client_attempt_id` - (client_attempt_id)

### attempt_photos

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `attempt_id` | uuid | no |  |
| `photo_index` | smallint | no |  |
| `s3_key` | text | no |  |
| `content_type` | text | no | `'image/jpeg'` |
| `declared_size_bytes` | int8 | yes |  |
| `size_bytes` | int8 | yes |  |
| `etag` | text | yes |  |
| `status` | text | no | `'awaiting_upload'` |
| `verified_at` | timestamptz | yes |  |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **CHECK** `chk_photo_index` - CHECK (((photo_index >= 0) AND (photo_index <= 3)))
- **CHECK** `chk_photo_status` - CHECK ((status = ANY (ARRAY['awaiting_upload'::text, 'verified'::text, 'deleted_retention'::text])))
- **FOREIGN KEY** `attempt_photos_attempt_id_fkey` - FOREIGN KEY (attempt_id) REFERENCES delivery_attempts(id)
- **PRIMARY KEY** `attempt_photos_pkey` - PRIMARY KEY (id)
- **UNIQUE** `uq_attempt_photos_attempt_index` - UNIQUE (attempt_id, photo_index)

Indexes:

- `uq_attempt_photos_attempt_index` - (attempt_id, photo_index)

### pods

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `stop_id` | uuid | no |  |
| `delivered` | bool | no |  |
| `photo_url` | text | yes |  |
| `signature_url` | text | yes |  |
| `location` | varchar | yes |  |
| `note` | text | yes |  |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **PRIMARY KEY** `pods_pkey` - PRIMARY KEY (id)
- **UNIQUE** `pods_stop_id_key` - UNIQUE (stop_id)

Indexes:

- `pods_stop_id_key` - (stop_id)

### drivers

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `employee_ref` | text | no |  |
| `display_name` | text | no |  |
| `password_hash` | text | no |  |
| `is_active` | bool | no | `true` |
| `created_at` | timestamptz | no | `now()` |
| `email` | text | yes |  |

Constraints:

- **PRIMARY KEY** `drivers_pkey` - PRIMARY KEY (id)
- **UNIQUE** `drivers_employee_ref_key` - UNIQUE (employee_ref)

Indexes:

- `drivers_employee_ref_key` - (employee_ref)
- `uq_drivers_email` - (lower(email))

### office_users

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `email` | text | no |  |
| `display_name` | text | no |  |
| `password_hash` | text | no |  |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **PRIMARY KEY** `office_users_pkey` - PRIMARY KEY (id)
- **UNIQUE** `office_users_email_key` - UNIQUE (email)

Indexes:

- `office_users_email_key` - (email)

### devices

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `device_fingerprint` | text | no |  |
| `platform` | text | no | `'android'` |
| `last_seen_app_version` | text | yes |  |
| `first_seen_at` | timestamptz | no | `now()` |
| `last_seen_at` | timestamptz | no | `now()` |

Constraints:

- **PRIMARY KEY** `devices_pkey` - PRIMARY KEY (id)
- **UNIQUE** `devices_device_fingerprint_key` - UNIQUE (device_fingerprint)

Indexes:

- `devices_device_fingerprint_key` - (device_fingerprint)

### refresh_tokens

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `token_hash` | text | no |  |
| `family_id` | uuid | no |  |
| `driver_id` | uuid | yes |  |
| `office_user_id` | uuid | yes |  |
| `device_id` | uuid | yes |  |
| `status` | text | no | `'active'` |
| `rotated_at` | timestamptz | yes |  |
| `successor_id` | uuid | yes |  |
| `expires_at` | timestamptz | no |  |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **CHECK** `chk_refresh_owner` - CHECK ((num_nonnulls(driver_id, office_user_id) = 1))
- **CHECK** `chk_refresh_status` - CHECK ((status = ANY (ARRAY['active'::text, 'rotated'::text, 'revoked'::text])))
- **FOREIGN KEY** `refresh_tokens_device_id_fkey` - FOREIGN KEY (device_id) REFERENCES devices(id)
- **FOREIGN KEY** `refresh_tokens_driver_id_fkey` - FOREIGN KEY (driver_id) REFERENCES drivers(id)
- **FOREIGN KEY** `refresh_tokens_office_user_id_fkey` - FOREIGN KEY (office_user_id) REFERENCES office_users(id)
- **PRIMARY KEY** `refresh_tokens_pkey` - PRIMARY KEY (id)

Indexes:

- `uq_refresh_tokens_hash` - (token_hash)
- `uq_refresh_tokens_one_active_per_family` - (family_id) WHERE (status = 'active'::text)

### ai_summaries

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `attempt_id` | uuid | no |  |
| `status` | text | no | `'pending'` |
| `draft_text` | text | yes |  |
| `source` | text | yes |  |
| `model` | text | yes |  |
| `prompt_version` | text | yes |  |
| `input_tokens` | int | yes |  |
| `output_tokens` | int | yes |  |
| `est_cost_usd` | numeric | yes |  |
| `generated_at` | timestamptz | yes |  |
| `final_text` | text | yes |  |
| `edited_by` | uuid | yes |  |
| `edited_at` | timestamptz | yes |  |
| `sent_at` | timestamptz | yes |  |

Constraints:

- **CHECK** `chk_ai_source` - CHECK (((source IS NULL) OR (source = ANY (ARRAY['bedrock'::text, 'template'::text]))))
- **CHECK** `chk_ai_status` - CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'fallback'::text, 'failed'::text, 'approved'::text])))
- **FOREIGN KEY** `ai_summaries_attempt_id_fkey` - FOREIGN KEY (attempt_id) REFERENCES delivery_attempts(id)
- **FOREIGN KEY** `ai_summaries_edited_by_fkey` - FOREIGN KEY (edited_by) REFERENCES office_users(id)
- **PRIMARY KEY** `ai_summaries_pkey` - PRIMARY KEY (id)
- **UNIQUE** `ai_summaries_attempt_id_key` - UNIQUE (attempt_id)

Indexes:

- `ai_summaries_attempt_id_key` - (attempt_id)

### ai_summary_cache

| column | type | null | default |
|---|---|---|---|
| `cache_key` | character | no |  |
| `summary_text` | text | no |  |
| `model` | text | no |  |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **PRIMARY KEY** `ai_summary_cache_pkey` - PRIMARY KEY (cache_key)

### erasure_log

| column | type | null | default |
|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` |
| `actor_id` | uuid | no |  |
| `subject_type` | text | no |  |
| `subject_id` | uuid | no |  |
| `fields_redacted` | jsonb | no |  |
| `tokens_revoked` | int | no | `0` |
| `created_at` | timestamptz | no | `now()` |

Constraints:

- **CHECK** `erasure_log_subject_type_check` - CHECK ((subject_type = ANY (ARRAY['driver'::text, 'office_user'::text])))
- **PRIMARY KEY** `erasure_log_pkey` - PRIMARY KEY (id)

Indexes:

- `idx_erasure_log_subject` - (subject_type, subject_id, created_at DESC)

### backfill_progress

| column | type | null | default |
|---|---|---|---|
| `job_id` | text | no |  |
| `last_created_at` | timestamptz | yes |  |
| `last_id` | uuid | yes |  |
| `rows_done` | int8 | no | `0` |
| `updated_at` | timestamptz | no | `now()` |

Constraints:

- **PRIMARY KEY** `backfill_progress_pkey` - PRIMARY KEY (job_id)

## Append-only, as enforced by grants

The runtime role holds no DELETE on either evidence table, and its UPDATE is
column-scoped. This is the guarantee the application cannot talk its way out
of, verified against the live database:

| table | pod_app UPDATE columns |
|---|---|
| `delivery_attempts` | `evidence_status`, `signature_declared_size_bytes`, `signature_size_bytes`, `signature_verified_at`, `updated_at` |
| `attempt_photos` | `status`, `size_bytes`, `etag`, `verified_at` |
| `erasure_log` | none (SELECT and INSERT only) |

Everything else on those tables is insert-only. `retry_today`, `barcode_match`,
`barcode_override_reason`, `conflict` and `conflict_reason` appear in the INSERT
grant and deliberately not in the UPDATE grant, so a later code path cannot
revise what the driver recorded at the door.

## Device SQLite (pod-v2.db)

Schema version lives in PRAGMA user_version; column additions are applied by
numbered, append-only steps in upgrade().

```sql
CREATE TABLE IF NOT EXISTS stops (
      stop_id        TEXT PRIMARY KEY,
      route_date     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      address        TEXT NOT NULL,
      postcode       TEXT NOT NULL,
      lat            REAL,
      lng            REAL,
      status         TEXT NOT NULL DEFAULT 'pending',
      removed        INTEGER NOT NULL DEFAULT 0,
      -- What dispatch says should be at this door, for the capture-time check.
      expected_barcode TEXT,
      -- Server-derived: is this stop still the driver's work today?
      live_today     INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_date, seq);

    -- ---- Evidence: device-owned, sacred, never bulk-deleted ----
    CREATE TABLE IF NOT EXISTS attempts (
      client_attempt_id      TEXT PRIMARY KEY,
      stop_id                TEXT NOT NULL REFERENCES stops(stop_id),
      attempt_no             INTEGER NOT NULL DEFAULT 1,
      outcome                TEXT,
      reason_code            TEXT,
      neighbour_house_number TEXT,
      note                   TEXT,
      parcel_barcode         TEXT,
      barcode_source         TEXT,
      -- Did the scan match what dispatch expected? NULL means nothing to
      -- compare against, which is not the same as a mismatch.
      barcode_match          INTEGER,
      barcode_override_reason TEXT,
      -- Carded and no-access only: the driver is coming back today.
      retry_today            INTEGER NOT NULL DEFAULT 0,
      signature_path         TEXT,
      lat                    REAL,
      lng                    REAL,
      gps_accuracy_m         REAL,
      captured_at            TEXT NOT NULL,
      -- elapsedRealtime at capture: inconsistency with the wall clock later
      -- exposes a device clock that was changed between capture and submit.
      captured_at_monotonic  INTEGER,
      driver_id              TEXT NOT NULL,
      device_id              TEXT NOT NULL,
      app_version            TEXT NOT NULL,

      sync_state             TEXT NOT NULL DEFAULT 'draft',
      retry_count            INTEGER NOT NULL DEFAULT 0,
      next_retry_at          TEXT,
      failure_kind           TEXT,
      last_error_code        TEXT,
      last_error_message     TEXT,
      server_attempt_id      TEXT,
      finalized_at           TEXT,
      synced_at              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_stop  ON attempts(stop_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_queue ON attempts(sync_state, next_retry_at);

    CREATE TABLE IF NOT EXISTS attempt_photos (
      client_attempt_id TEXT NOT NULL REFERENCES attempts(client_attempt_id),
      photo_index       INTEGER NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'photo',
      local_path        TEXT NOT NULL,
      byte_size         INTEGER NOT NULL,
      upload_state      TEXT NOT NULL DEFAULT 'pending',
      retry_count       INTEGER NOT NULL DEFAULT 0,
      confirmed_at      TEXT,
      PRIMARY KEY (client_attempt_id, photo_index)
    );
    CREATE INDEX IF NOT EXISTS idx_photos_state ON attempt_photos(upload_state);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
```
