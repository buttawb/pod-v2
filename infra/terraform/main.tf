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

module "iam" {
  source = "./modules/iam"

  evidence_bucket_arn = module.storage.evidence_bucket_arn
}

module "compute" {
  source = "./modules/compute"

  instance_type         = var.instance_type
  ssh_public_key        = var.ssh_public_key
  ssh_ingress_cidr      = var.ssh_ingress_cidr
  instance_profile_name = module.iam.instance_profile_name
}

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
