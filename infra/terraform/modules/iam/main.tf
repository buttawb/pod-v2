variable "evidence_bucket_arn" { type = string }
variable "runtime_secret_arn" { type = string }

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backend" {
  name               = "pod-v2-role-backend"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

# Scoped to exactly what the API does: presign/verify evidence objects under
# attempts/*, and invoke Bedrock. No static keys exist anywhere in the system.
data "aws_iam_policy_document" "backend" {
  statement {
    sid = "EvidenceObjects"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:HeadObject",
    ]
    resources = ["${var.evidence_bucket_arn}/attempts/*"]
  }

  statement {
    sid       = "ReadRuntimeSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.runtime_secret_arn]
  }

  statement {
    sid = "BedrockInvoke"
    actions = [
      "bedrock:InvokeModel",
    ]
    # Inference profiles route across regions; both ARN families are needed.
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:*:inference-profile/*",
    ]
  }
}

resource "aws_iam_role_policy" "backend" {
  name   = "pod-v2-policy-backend"
  role   = aws_iam_role.backend.id
  policy = data.aws_iam_policy_document.backend.json
}

resource "aws_iam_instance_profile" "backend" {
  name = "pod-v2-instance-profile-backend"
  role = aws_iam_role.backend.name
}

output "instance_profile_name" { value = aws_iam_instance_profile.backend.name }
