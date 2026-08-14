terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Local state is a deliberate take-home scope cut: a single operator, a
  # single environment. The production story is an S3 backend with DynamoDB
  # locking (see DECISIONS.md).
  backend "local" {}
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "pod-v2"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

module "storage" {
  source = "./modules/storage"

  evidence_bucket_name = "pod-v2-evidence-${data.aws_caller_identity.current.account_id}"
  apk_bucket_name      = "pod-v2-apk-${data.aws_caller_identity.current.account_id}"
}

module "secrets" {
  source = "./modules/secrets"
}

module "iam" {
  source = "./modules/iam"

  evidence_bucket_arn = module.storage.evidence_bucket_arn
  runtime_secret_arn  = module.secrets.secret_arn
}

module "compute" {
  source = "./modules/compute"

  instance_type         = var.instance_type
  ssh_public_key        = var.ssh_public_key
  ssh_ingress_cidr      = var.ssh_ingress_cidr
  db_ingress_cidr       = var.db_ingress_cidr
  instance_profile_name = module.iam.instance_profile_name
}

# The load-test runner holds no data and never needs a SQL client pointed at it,
# so it does not inherit db_ingress_cidr.
module "loadtest" {
  source = "./modules/compute"
  count  = var.enable_loadtest_runner ? 1 : 0

  name_suffix           = "-loadtest"
  instance_type         = "t3.medium"
  ssh_public_key        = var.ssh_public_key
  ssh_ingress_cidr      = var.ssh_ingress_cidr
  instance_profile_name = module.iam.instance_profile_name
  open_web_ports        = false
}

# ---------------------------------------------------------------------------
# Aurora. Off by default: the live database is still the Postgres container on
# the app box, and an apply by anyone who has not opted in should change
# nothing at all. Both lookups below are counted off alongside the module, so a
# default apply does not even read them.
# ---------------------------------------------------------------------------

# The compute module owns the API host's security group and exposes no id
# output for it, and that module is out of scope for this change, so the group
# is resolved by the name compute builds. A literal sg- id pasted here would
# survive exactly until the next time that instance is replaced.
data "aws_security_group" "app_host" {
  count = var.enable_aurora ? 1 : 0

  name = "pod-v2-sg-host"
}

# Aurora reuses the POSTGRES_PASSWORD already in Secrets Manager, read live
# rather than generated fresh. Two reasons.
#
# deploy.sh renders DATABASE_OWNER_URL from that same key, so cutover becomes a
# change of host and nothing else, with no window where the rendered .env and
# the secret disagree about a credential.
#
# And a new key cannot usefully be added to the secrets module: its
# aws_secretsmanager_secret_version carries lifecycle ignore_changes on
# secret_string, so adding an AURORA_PASSWORD to that jsonencode would apply
# cleanly, report no diff, and never reach the live secret. It would look like
# it worked. Set var.aurora_master_password to use a separate credential.
data "aws_secretsmanager_secret_version" "runtime" {
  count = var.enable_aurora ? 1 : 0

  secret_id = module.secrets.secret_arn
}

module "database" {
  source = "./modules/database"
  count  = var.enable_aurora ? 1 : 0

  app_security_group_id = data.aws_security_group.app_host[0].id

  master_password = coalesce(
    var.aurora_master_password,
    jsondecode(data.aws_secretsmanager_secret_version.runtime[0].secret_string)["POSTGRES_PASSWORD"],
  )
}
