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
