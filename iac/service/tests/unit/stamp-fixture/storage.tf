locals {
  # Storage account names: lowercase, no hyphens, ≤24 chars.
  # Mirrors legacy iac/storage.tf naming (`replace("st${local.prefix}", "-", "")`)
  # where `local.prefix = "bccweb-${var.stamp_name}"`. Recomputed inline here
  # because the root module does not pass `prefix` into the stamp module.
  storage_prefix       = "bccweb-${var.stamp_name}"
  storage_account_name = replace("st${local.storage_prefix}", "-", "")
}

# ─── Storage Account ─────────────────────────────────────────────────────────

resource "azapi_resource" "storage" {
  type      = "Microsoft.Storage/storageAccounts@2025-06-01"
  name      = local.storage_account_name
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "StorageV2"
    sku = {
      name = "Standard_GRS"
    }
    properties = {
      # Required to allow container-level and blob-level public access
      allowBlobPublicAccess    = true
      supportsHttpsTrafficOnly = true
      minimumTlsVersion        = "TLS1_2"
    }
  }

  response_export_values = ["name"]
}

# ─── Management Lock ─────────────────────────────────────────────────────────
#
# Prevents accidental deletion of the storage account. Must be removed via a
# deliberate operator action before any destroy is attempted.

resource "azapi_resource" "storage_lock" {
  type      = "Microsoft.Authorization/locks@2020-05-01"
  name      = "storage-nodelete"
  parent_id = azapi_resource.storage.id

  body = {
    properties = {
      level = "CanNotDelete"
      notes = "Prevents accidental destroy; remove via deliberate operator action"
    }
  }

  depends_on = [azapi_resource.storage]
}

# ─── Blob Service ────────────────────────────────────────────────────────────
#
# Versioning, change feed, and soft-delete protect against data loss.
# CORS is locked to var.allowed_origins (no wildcard).

resource "azapi_resource" "blob_service" {
  type      = "Microsoft.Storage/storageAccounts/blobServices@2025-06-01"
  name      = "default"
  parent_id = azapi_resource.storage.id

  body = {
    properties = {
      isVersioningEnabled = true
      changeFeed = {
        enabled = true
      }
      deleteRetentionPolicy = {
        enabled = true
        days    = 7
      }
      containerDeleteRetentionPolicy = {
        enabled = true
        days    = 7
      }
      cors = {
        corsRules = [
          {
            allowedOrigins  = var.allowed_origins
            allowedMethods  = ["GET", "HEAD", "OPTIONS"]
            allowedHeaders  = ["Content-Type", "Authorization", "x-ms-version", "x-ms-date", "x-ms-blob-type", "If-Match", "If-None-Match", "If-Modified-Since", "Range"]
            exposedHeaders  = ["x-ms-request-id", "x-ms-version", "Content-Length", "Content-Type", "ETag", "Last-Modified"]
            maxAgeInSeconds = 3600
          }
        ]
      }
    }
  }
}

# ─── Blob Container ───────────────────────────────────────────────────────────
#
# Public blob-level access — anonymous GET for any blob in this container.
# Functions still authenticate with the storage connection string for writes.

resource "azapi_resource" "storage_container_data" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = "data"
  parent_id = azapi_resource.blob_service.id

  body = {
    properties = {
      publicAccess = "Blob"
    }
  }
}

# ─── Private Blob Container ──────────────────────────────────────────────────
#
# No public access — only the Function App (via connection string) can read/write.
# Stores credentials, PII, pilot details, round documents, and other sensitive data.

resource "azapi_resource" "storage_container_data_private" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = "data-private"
  parent_id = azapi_resource.blob_service.id

  body = {
    properties = {
      publicAccess = "None"
    }
  }
}

# ─── Queue Service ───────────────────────────────────────────────────────────
#
# Backs the async round-brief PDF and sign-to-fly reflect pipelines. The API
# enqueues jobs on the `round-brief-pdf` / `signtofly-reflect` queues; queue-
# triggered Functions process them. The queue service is the parent for all
# named queues (name must be "default").

resource "azapi_resource" "queue_service" {
  type      = "Microsoft.Storage/storageAccounts/queueServices@2025-06-01"
  name      = "default"
  parent_id = azapi_resource.storage.id

  body = {
    properties = {}
  }
}

# ─── Round-Brief PDF Queues ──────────────────────────────────────────────────
#
# `round-brief-pdf` carries BriefPdfJob messages (roundId, briefVersion,
# pdfAttemptId — no PII). `round-brief-pdf-poison` collects messages that
# exhaust the Functions host retry budget. Names MUST match the producer /
# consumer AzureWebJobsStorage queue bindings — do not rename.

resource "azapi_resource" "queue_brief_pdf" {
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name      = "round-brief-pdf"
  parent_id = azapi_resource.queue_service.id
}

resource "azapi_resource" "queue_brief_pdf_poison" {
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name      = "round-brief-pdf-poison"
  parent_id = azapi_resource.queue_service.id
}

# ─── Sign-to-Fly Reflect Queues ──────────────────────────────────────────────
#
# `signtofly-reflect` carries reflect-job messages ({ roundId } — no PII).
# `signtofly-reflect-poison` collects messages that exhaust the Functions host
# retry budget. Names MUST match the producer / consumer AzureWebJobsStorage
# queue bindings — do not rename.

resource "azapi_resource" "queue_signtofly_reflect" {
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name      = "signtofly-reflect"
  parent_id = azapi_resource.queue_service.id
}

resource "azapi_resource" "queue_signtofly_reflect_poison" {
  type      = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name      = "signtofly-reflect-poison"
  parent_id = azapi_resource.queue_service.id
}

# ─── Storage Account Keys ────────────────────────────────────────────────────
#
# Used to construct the connection string for the Function App.
# NON-ephemeral: the resulting connection string is consumed by Function App
# app settings via local.storage_primary_connection_string (iac/modules/stamp/functions.tf),
# which must be available at plan time.

resource "azapi_resource_action" "storage_keys" {
  type        = "Microsoft.Storage/storageAccounts@2025-06-01"
  resource_id = azapi_resource.storage.id
  action      = "listKeys"
  method      = "POST"

  response_export_values = ["keys"]
}

locals {
  storage_primary_key               = azapi_resource_action.storage_keys.output.keys[0].value
  storage_primary_connection_string = "DefaultEndpointsProtocol=https;AccountName=${local.storage_account_name};AccountKey=${local.storage_primary_key};EndpointSuffix=core.windows.net"
}

# ─── Blob Lifecycle Management Policy ────────────────────────────────────────
#
# GC short-lived auth token blobs from data-private after 7 days.
# Prevents accumulation of expired tokens that were never consumed.

resource "azapi_resource" "storage_lifecycle" {
  type      = "Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01"
  name      = "default"
  parent_id = azapi_resource.storage.id

  body = {
    properties = {
      policy = {
        rules = [
          {
            name    = "gc-auth-tokens"
            enabled = true
            type    = "Lifecycle"
            definition = {
              filters = {
                blobTypes   = ["blockBlob"]
                prefixMatch = ["data-private/auth/tokens/"]
              }
              actions = {
                baseBlob = {
                  delete = {
                    daysAfterModificationGreaterThan = 7
                  }
                }
              }
            }
          }
        ]
      }
    }
  }

  depends_on = [azapi_resource.blob_service, azapi_resource.storage_container_data_private]
}
