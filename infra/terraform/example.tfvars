# Copy to terraform.tfvars (gitignored) and fill in.
aws_region       = "ap-southeast-1"
aws_profile      = "personal"
instance_type    = "t3.small"
ssh_public_key   = "ssh-ed25519 AAAA... you@host"
ssh_ingress_cidr = "203.0.113.10/32" # your current IP: curl -s ifconfig.me
