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

# All null until enable_aurora is set, which is also the quickest way to
# confirm from the outside that the flag really does gate everything.
output "aurora_writer_endpoint" {
  value       = var.enable_aurora ? module.database[0].writer_endpoint : null
  description = "Host for DATABASE_URL and DATABASE_OWNER_URL after cutover"
}

output "aurora_reader_endpoint" {
  value       = var.enable_aurora ? module.database[0].reader_endpoint : null
  description = "Reader endpoint; resolves to the writer while there is one instance"
}

output "aurora_port" {
  value = var.enable_aurora ? module.database[0].port : null
}

output "aurora_cluster_identifier" {
  value = var.enable_aurora ? module.database[0].cluster_identifier : null
}
