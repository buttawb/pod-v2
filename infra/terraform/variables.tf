variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "aws_profile" {
  type    = string
  default = "personal"
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key material for the admin key pair"
}

variable "ssh_ingress_cidr" {
  type        = string
  description = "CIDR allowed to reach SSH; keep this your own IP, never 0.0.0.0/0"

  validation {
    condition     = var.ssh_ingress_cidr != "0.0.0.0/0"
    error_message = "SSH must not be open to the world; pass your current IP as x.x.x.x/32."
  }
}

# Left closed by default. Opening it puts a real database behind nothing but a
# generated password, so it is set explicitly in tfvars for the demo walkthrough
# and should be closed, or the box destroyed, once that is over.
variable "db_ingress_cidr" {
  type        = string
  default     = null
  description = "CIDR allowed to reach Postgres on 5432; null leaves the port closed"
}

variable "enable_loadtest_runner" {
  type        = bool
  default     = false
  description = "Provision the separate k6 runner instance (only needed on load-test day)"
}

# Off until someone chooses to move. The database still serving traffic is the
# Postgres container on the app box, and this flag is what keeps a routine
# apply from standing up a second one nobody asked for.
variable "enable_aurora" {
  type        = bool
  default     = false
  description = "Provision the Aurora PostgreSQL Serverless v2 cluster and its private subnets"
}

# Null means reuse POSTGRES_PASSWORD from the Secrets Manager entry that
# already exists, which is what keeps the cutover to a change of host. Set this
# to give Aurora a credential of its own, and expect to update the secret and
# re-run deploy.sh in the same change, or the API will authenticate with a
# password the new database has never heard of.
variable "aurora_master_password" {
  type        = string
  default     = null
  sensitive   = true
  description = "Aurora master password; null reuses POSTGRES_PASSWORD from Secrets Manager"
}
