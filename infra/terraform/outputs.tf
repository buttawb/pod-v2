output "backend_public_ip" {
  value       = module.compute.public_ip
  description = "EIP of the API host; point the DNS A record here"
}

output "evidence_bucket" {
  value = module.storage.evidence_bucket_name
}

output "apk_bucket" {
  value = module.storage.apk_bucket_name
}

output "apk_public_url_base" {
  value       = module.storage.apk_public_url_base
  description = "Public base URL for the APK download link"
}

output "loadtest_public_ip" {
  value = var.enable_loadtest_runner ? module.loadtest[0].public_ip : null
}

output "runtime_secret_name" {
  value       = module.secrets.secret_name
  description = "Secrets Manager entry the instance reads at boot"
}
