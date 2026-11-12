# Tailnet policy and jerry's auth key. The provider reads TAILSCALE_API_KEY.

terraform {
  required_version = ">= 1.9"
  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29"
    }
  }
}

provider "tailscale" {}

variable "family" {
  description = "Emails of people who may use jerry as an exit node and reach nothing else."
  type        = list(string)
  default     = []
}

locals {
  base = jsondecode(file("${path.module}/policy.json"))
  policy = merge(local.base, {
    groups = { "group:family" = var.family }
    tests  = [for test in local.base.tests : test if length(var.family) > 0]
  })
}

resource "tailscale_acl" "policy" {
  acl                        = jsonencode(local.policy)
  overwrite_existing_content = true
}

resource "tailscale_tailnet_key" "jerry" {
  description         = "jerry"
  reusable            = false
  preauthorized       = true
  tags                = ["tag:jerry"]
  expiry              = 86400
  recreate_if_invalid = "always"
  depends_on          = [tailscale_acl.policy]
}

output "jerry_auth_key" {
  value     = tailscale_tailnet_key.jerry.key
  sensitive = true
}
