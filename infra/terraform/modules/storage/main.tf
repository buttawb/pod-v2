variable "evidence_bucket_name" { type = string }
variable "apk_bucket_name" { type = string }

# ---------------------------------------------------------------------------
# Evidence bucket: fully private. All access is presigned (short TTL) or via
# the instance role. Versioning is on as accidental-overwrite protection for
# legal evidence; TLS-only access is enforced by policy.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "evidence" {
  bucket = var.evidence_bucket_name
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "evidence_tls_only" {
  bucket     = aws_s3_bucket.evidence.id
  depends_on = [aws_s3_bucket_public_access_block.evidence]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.evidence.arn,
        "${aws_s3_bucket.evidence.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

resource "aws_s3_bucket_cors_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  # Presigned PUTs come from the app's HTTP client (no CORS) and, during
  # development, from tools; GETs are 302-redirected browser loads.
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  # The 100x cost answer, encoded: evidence views after 90 days are rare but
  # must stay instant for disputes.
  rule {
    id     = "evidence-tiering"
    status = "Enabled"

    filter {
      prefix = "attempts/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    # Six years, the confirmed retention for proof of delivery: these records
    # exist to establish or defend a legal claim, and the claims window is what
    # sets the number. 2192 days is 6 x 365 plus two leap days.
    #
    # This was 550 days, an earlier 18-month assumption that survived the
    # policy being confirmed. That is a bad failure mode to leave in place:
    # S3 enforces expiry itself, so evidence would have been destroyed roughly
    # four and a half years early, silently, on a rolling basis, with nothing
    # in the API to log or notice it. A retention number that is wrong in the
    # deleting direction cannot be corrected after the fact.
    #
    # Enforced declaratively so it holds even if the application-side redaction
    # job never runs. Versions are expired too: a versioned bucket that only
    # deletes current objects keeps the evidence forever behind a delete marker.
    expiration {
      days = 2192
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# APK bucket: exactly one deliverable requires a truly public click-to-download
# link (the submission repo is private). Public read on objects, nothing else.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "apk" {
  bucket = var.apk_bucket_name
}

resource "aws_s3_bucket_public_access_block" "apk" {
  bucket = aws_s3_bucket.apk.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "apk_public_read" {
  bucket     = aws_s3_bucket.apk.id
  depends_on = [aws_s3_bucket_public_access_block.apk]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadApk"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.apk.arn}/*"
    }]
  })
}

output "evidence_bucket_name" { value = aws_s3_bucket.evidence.bucket }
output "evidence_bucket_arn" { value = aws_s3_bucket.evidence.arn }
output "apk_bucket_name" { value = aws_s3_bucket.apk.bucket }
output "apk_public_url_base" {
  value = "https://${aws_s3_bucket.apk.bucket}.s3.${aws_s3_bucket.apk.region}.amazonaws.com"
}
