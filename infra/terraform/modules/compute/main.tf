variable "name_suffix" {
  type    = string
  default = ""
}
variable "instance_type" { type = string }
variable "ssh_public_key" { type = string }
variable "ssh_ingress_cidr" { type = string }
variable "instance_profile_name" { type = string }
variable "open_web_ports" {
  type    = bool
  default = true
}

# Postgres is normally unreachable from outside the Docker network: the compose
# file gives it no host port, and nothing but the two backend containers speaks
# to it. Setting this opens 5432 on the host firewall, which is only wanted when
# a human needs a SQL client pointed at the demo data.
#
# Deliberately not defaulted to open. Passing "0.0.0.0/0" is a decision the
# operator makes in tfvars, in the open, rather than something inherited here.
variable "db_ingress_cidr" {
  type        = string
  default     = null
  description = "CIDR allowed to reach Postgres on 5432; null leaves the port closed"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_key_pair" "admin" {
  key_name   = "pod-v2-key-admin${var.name_suffix}"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "host" {
  name        = "pod-v2-sg-host${var.name_suffix}"
  description = "pod-v2 host: web from anywhere (when enabled), SSH from operator only"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = var.open_web_ports ? [80, 443] : []

    content {
      description = "web"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  ingress {
    description = "ssh from operator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_ingress_cidr]
  }

  dynamic "ingress" {
    for_each = var.db_ingress_cidr == null ? [] : [var.db_ingress_cidr]

    content {
      description = "postgres for SQL clients, opened deliberately for the demo"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "host" {
  ami                    = nonsensitive(data.aws_ssm_parameter.al2023_ami.value)
  instance_type          = var.instance_type
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = var.instance_profile_name

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  # T3 Unlimited: a burstable box exhausting CPU credits mid-load-test would
  # measure the credit system, not the code.
  credit_specification {
    cpu_credits = "unlimited"
  }

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail
    dnf install -y docker git
    systemctl enable --now docker
    usermod -aG docker ec2-user
    DOCKER_CONFIG=/usr/local/lib/docker
    mkdir -p $DOCKER_CONFIG/cli-plugins
    curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
      -o $DOCKER_CONFIG/cli-plugins/docker-compose
    chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose
    ln -sf $DOCKER_CONFIG/cli-plugins/docker-compose /usr/local/bin/docker-compose
  EOF

  tags = {
    Name = "pod-v2-ec2-backend${var.name_suffix}"
  }
}

resource "aws_eip" "host" {
  instance = aws_instance.host.id
  domain   = "vpc"

  tags = {
    Name = "pod-v2-eip-backend${var.name_suffix}"
  }
}

output "public_ip" { value = aws_eip.host.public_ip }
output "instance_id" { value = aws_instance.host.id }
