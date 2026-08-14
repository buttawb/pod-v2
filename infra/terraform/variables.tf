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

variable "enable_loadtest_runner" {
  type        = bool
  default     = false
  description = "Provision the separate k6 runner instance (only needed on load-test day)"
}

# The floor bills continuously and the ceiling only bills what a workload
# actually draws, so these are not symmetrical decisions.
#
# The floor stays small because the working set is tiny and cached. It is not
# zero on purpose: scale-to-zero parks an idle cluster and charges the next
# connection a resume of ten to fifteen seconds, which a demo that sits idle
# between viewings would pay every single time, and which the health check would
# read as an outage.
#
# The ceiling is set for the large seed and the load test that follows it.
# Bulk-inserting tens of millions of rows against a low ceiling measures the
# ceiling, and a capacity number that really describes a throttle is worse than
# no number.
variable "aurora_min_capacity" {
  type        = number
  default     = 0.5
  description = "Serverless v2 floor in ACUs; billed continuously"
}

variable "aurora_max_capacity" {
  type        = number
  default     = 16
  description = "Serverless v2 ceiling in ACUs; billed only when drawn"
}

# Null reuses POSTGRES_PASSWORD from the Secrets Manager entry, which is what
# keeps one copy of the credential. Set this to give the cluster one of its own,
# and expect to update the secret and re-run deploy.sh in the same change, or
# the API authenticates with a password the database has never heard of.
variable "aurora_master_password" {
  type        = string
  default     = null
  sensitive   = true
  description = "Aurora master password; null reuses POSTGRES_PASSWORD from Secrets Manager"
}
