# ---------------------------------------------------------------------------
# Aurora PostgreSQL Serverless v2: the destination half of a database move.
#
# Today the data lives in a Postgres container sharing one EC2 box with the
# API. That box is a single point of failure for both, the volume is backed up
# by nothing, and a lost instance is a lost database. This module builds the
# replacement. It deliberately touches none of that: the container keeps
# running as the fallback until the cutover is proven against real row counts.
#
# Everything here is inert unless the caller opts in (var.enable_aurora at the
# root), so an apply by someone who has not chosen to move changes nothing.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  type        = string
  default     = "pod-v2"
  description = "Prefix for every name this module creates"
}

variable "app_security_group_id" {
  type        = string
  description = "Security group of the API host, the only source allowed to reach 5432"
}

variable "engine_version" {
  type        = string
  default     = "16.14"
  description = "Aurora PostgreSQL version; matches the running server exactly"
}

variable "database_name" {
  type    = string
  default = "pod"
}

variable "master_username" {
  type    = string
  default = "pod"
}

# Never generated here and never written down. The caller passes it, and the
# caller reads it from the Secrets Manager entry that already exists, so this
# module owns no credential material and adds no second place a password can
# drift out of sync.
variable "master_password" {
  type      = string
  sensitive = true

  validation {
    # RDS rejects /, ", @ and spaces outright. The rest of the rule is ours:
    # this password ends up inside a postgres:// URL in a rendered .env, and a
    # short one there is a short one everywhere.
    condition     = length(var.master_password) >= 16 && length(var.master_password) <= 128 && !can(regex("[/\"@ ]", var.master_password))
    error_message = "master_password must be 16-128 characters and must not contain /, \", @ or a space."
  }
}

# The whole database is roughly 12k rows across every table, well under 100 MB,
# so memory is not what sets these numbers. 1 ACU is about 2 GiB.
#
# min 0.5: the smallest floor that keeps the instance warm. At 1 GiB the entire
# working set is cached many times over. Not 0: scale-to-zero would park the
# cluster after idle and charge the first connection a resume of roughly ten to
# fifteen seconds, which the API's connection pool and the health check would
# both read as an outage. A demo that is idle between viewings is exactly the
# workload that would hit that path every single time.
#
# max 4: about 8 GiB, four times the memory of the t3.small that currently runs
# the API and the database together. That ceiling means a k6 ramp is bounded by
# the application, not by the database, while still capping the blast radius of
# a runaway query. Note the floor bills continuously, so 0.5 is a cost decision
# as much as a performance one.
variable "min_capacity" {
  type        = number
  default     = 0.5
  description = "Serverless v2 floor in ACUs"
}

variable "max_capacity" {
  type        = number
  default     = 4
  description = "Serverless v2 ceiling in ACUs"
}

variable "backup_retention_period" {
  type        = number
  default     = 7
  description = "Days of automated backups; 7 is the floor worth having, not a target"

  validation {
    condition     = var.backup_retention_period >= 7
    error_message = "backup_retention_period must be at least 7 days."
  }
}

# Both windows are UTC. 17:00 UTC is 01:00 in Singapore, the quietest hour for
# this deployment, and it stays clear of the 00:05 UTC demo-route roll timer on
# the app box. The maintenance window must not overlap the backup window.
variable "preferred_backup_window" {
  type    = string
  default = "17:00-17:30"
}

variable "preferred_maintenance_window" {
  type    = string
  default = "sun:18:00-sun:18:30"
}

# Deliberate, and deliberately opposite to each other.
#
# deletion_protection = false: this is a demo cluster with a scheduled teardown.
# A cluster that refuses terraform destroy is a cluster that quietly bills
# forever after the take-home is over, and the old Postgres container still
# holds the same rows, so Aurora is not the only copy of anything.
#
# skip_final_snapshot = false: that teardown still leaves a restorable snapshot
# behind. It is the cheap insurance that makes turning deletion protection off
# a safe call rather than a careless one. The identifier is static, so a second
# create-and-destroy cycle needs this bumped or the destroy fails on a name
# collision, which is the correct failure: it refuses to overwrite the snapshot
# from the previous cluster.
variable "deletion_protection" {
  type    = bool
  default = false
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "final_snapshot_identifier" {
  type    = string
  default = "pod-v2-aurora-final"
}

# The default VPC ships three subnets and every one of them is public. Aurora
# has to go somewhere else, and these are free /24s inside the existing
# 172.31.0.0/16. One per AZ.
variable "private_subnet_cidrs" {
  type        = list(string)
  default     = ["172.31.100.0/24", "172.31.101.0/24", "172.31.102.0/24"]
  description = "Unused /24s in the default VPC CIDR, one per availability zone"

  validation {
    # A DB subnet group spans availability zones even when the cluster runs a
    # single instance, because Aurora's storage layer is replicated across
    # three AZs regardless of how many instances you attach to it.
    condition     = length(var.private_subnet_cidrs) >= 2
    error_message = "Aurora needs subnets in at least two availability zones."
  }
}

# Same VPC as the API host, on purpose. Aurora is reachable by security group
# reference, which does not work across a VPC boundary without peering, and
# peering for one database on one box is machinery with no payoff.
data "aws_vpc" "default" {
  default = true
}

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# Private subnets. The default VPC has none, so build them.
# ---------------------------------------------------------------------------

resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  vpc_id            = data.aws_vpc.default.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # Belt and braces. Nothing launches instances here, but the default VPC's own
  # subnets all have this set to true and inheriting that habit would be bad.
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-subnet-db-${data.aws_availability_zones.available.names[count.index]}"
  }
}

# This route table is what actually makes those subnets private. It has no
# route block, which leaves it with only the VPC-local route AWS adds
# implicitly: no internet gateway, no NAT, no path off the VPC in either
# direction. Without it the subnets would fall back to the default VPC's main
# route table, which does carry 0.0.0.0/0 to the IGW, and "private subnet"
# would be a comment rather than a fact.
resource "aws_route_table" "private" {
  vpc_id = data.aws_vpc.default.id

  tags = {
    Name = "${var.name_prefix}-rt-db-private"
  }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_db_subnet_group" "aurora" {
  name        = "${var.name_prefix}-subnet-group-db"
  subnet_ids  = aws_subnet.private[*].id
  description = "Private subnets for the PoD Aurora cluster"

  tags = {
    Name = "${var.name_prefix}-subnet-group-db"
  }
}

# ---------------------------------------------------------------------------
# Security group: one way in, from one place.
# ---------------------------------------------------------------------------

resource "aws_security_group" "aurora" {
  name        = "${var.name_prefix}-sg-aurora"
  description = "pod-v2 Aurora: 5432 from the API host security group only"
  vpc_id      = data.aws_vpc.default.id

  # Referenced by group, not by CIDR. The API host sits on an EIP today and a
  # rebuilt box gets a new address, so a CIDR rule would be a rule that breaks
  # on the next replace. A group reference survives it.
  ingress {
    description     = "postgres from the API host only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }

  # No egress block, and that is the point: Terraform revokes the default
  # allow-all rule, leaving the cluster with no outbound path at all. Postgres
  # never initiates connections here, and the RDS-managed features in use
  # (automated backups, Performance Insights, log export) run on the service's
  # own path rather than through this interface.
}

# ---------------------------------------------------------------------------
# The cluster.
# ---------------------------------------------------------------------------

resource "aws_rds_cluster" "pod" {
  cluster_identifier = "${var.name_prefix}-aurora"
  engine             = "aurora-postgresql"

  # engine_mode is left at its default of "provisioned". That reads wrong and
  # is correct: Serverless v2 is a provisioned cluster with serverless
  # instances attached. engine_mode = "serverless" is the v1 product, which is
  # a different and worse thing.
  #
  # The version is an exact match to the 16.14 server being migrated from. Same
  # major and same minor means the dump restores without a version-skew
  # argument, and it removes one variable from the comparison when the row
  # counts are checked afterwards.
  engine_version = var.engine_version

  database_name = var.database_name

  master_username = var.master_username
  master_password = var.master_password

  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.aurora.id]

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  storage_encrypted = true # aws/rds managed key; the whole point of moving off an unencrypted Docker volume

  backup_retention_period      = var.backup_retention_period
  preferred_backup_window      = var.preferred_backup_window
  preferred_maintenance_window = var.preferred_maintenance_window
  copy_tags_to_snapshot        = true # a snapshot with no Project tag is a snapshot nobody can attribute later

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  # The Postgres log is the first thing anyone wants during a cutover, and the
  # container's docker logs will not be there to read once the API points here.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # A demo cluster has no maintenance window worth deferring to. A change that
  # silently lands at 18:00 UTC on Sunday is harder to reason about than one
  # that lands when it was asked for.
  apply_immediately = true

  lifecycle {
    precondition {
      condition     = var.min_capacity <= var.max_capacity
      error_message = "min_capacity must not exceed max_capacity."
    }
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.name_prefix}-aurora-1"
  cluster_identifier = aws_rds_cluster.pod.id
  engine             = aws_rds_cluster.pod.engine
  engine_version     = aws_rds_cluster.pod.engine_version
  instance_class     = "db.serverless"

  # The subnets have no route to an internet gateway, so this is already true
  # in practice. Stating it means the guarantee does not depend on nobody ever
  # editing that route table.
  publicly_accessible = false

  # Free tier, 7 day retention. The reason to have it is the cutover itself:
  # "the queries are slower on Aurora" needs an answer better than a shrug.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Pinned off because engine_version is pinned to an exact 16.14. Letting AWS
  # move the minor version in a maintenance window would make Terraform report
  # drift on a cluster nobody touched, and would break the exact-match property
  # this migration is being verified against. Turning it back on is a follow-up
  # with a version bump attached, not a default.
  auto_minor_version_upgrade = false

  copy_tags_to_snapshot = true
  apply_immediately     = true

  tags = {
    Name = "${var.name_prefix}-aurora-1"
  }
}

# ---------------------------------------------------------------------------
# What the caller needs to point the application here.
#
# Two things this module cannot do for you, stated here so they do not get
# discovered at cutover time:
#
# 1. The pod_app runtime role does not exist on this cluster. On the container
#    it is created by infra/init-db/01-create-app-role.sh, which only ever runs
#    on Docker's first-init of an empty volume. Aurora never runs it. The role
#    has to be created explicitly with CREATE ROLE before DATABASE_URL will
#    connect. The append-only grants on delivery_attempts and attempt_photos do
#    come across, because migrations 0003 and 0005 create them, but a grant to
#    a role that does not exist fails, so the role comes first.
#
# 2. /etc/systemd/system/pod-demo-roll.service still runs psql against the
#    local container by name (docker exec pod-v2-postgres-1). It will keep
#    rolling the old database after cutover, silently, and the demo route on
#    Aurora will stop advancing. It has to be repointed in the same change.
# ---------------------------------------------------------------------------

output "writer_endpoint" {
  value       = aws_rds_cluster.pod.endpoint
  description = "Cluster writer endpoint; this is the host for DATABASE_URL"
}

output "reader_endpoint" {
  value       = aws_rds_cluster.pod.reader_endpoint
  description = "Reader endpoint; with a single instance it resolves to the writer"
}

output "port" {
  value = aws_rds_cluster.pod.port
}

output "cluster_identifier" {
  value = aws_rds_cluster.pod.cluster_identifier
}

output "security_group_id" {
  value       = aws_security_group.aurora.id
  description = "Aurora security group, for wiring further callers"
}
