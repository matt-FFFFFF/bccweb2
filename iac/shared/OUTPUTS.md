# Shared Terraform outputs contract

The `iac/shared` state exposes exactly the nine non-secret outputs below. Adding,
removing, or renaming an output is a contract change and requires updating its
consumers and `scripts/iac/check-shared-resource-contract.sh` in the same change.

| Output | Description | Consumer |
| --- | --- | --- |
| `app_insights_ids` | Application Insights resource IDs keyed by stable environment name (`staging` and `prod`). | Stamp-consumed: each environment selects its own ID from shared remote state. |
| `log_analytics_workspace_id` | Resource ID of the shared Log Analytics workspace. | Deploy-workflow/operator-consumed for shared topology inspection and operations. |
| `acs_id` | Resource ID of the shared Azure Communication Service. | Stamp-consumed for ACS access and configuration. |
| `acs_email_domain_id` | Resource ID of the shared customer-managed ACS email domain. | Deploy-workflow/operator-consumed for email-domain verification and inspection. |
| `acs_sender_address` | Public sender address configured for the shared ACS email domain. | Stamp-consumed as the application sender address. |
| `acs_dns_records_for_operator` | Registrar-ready ACS domain ownership, SPF, DKIM, DKIM2, and DMARC verification records. | Deploy-workflow/operator-consumed during email-domain verification. |
| `swa_name` | Frozen name of the shared Standard Static Web App. | Deploy-workflow/operator-consumed for SPA deployment. |
| `swa_default_hostname` | Azure-assigned production hostname of the shared Static Web App. | Deploy-workflow/operator-consumed for deployment and DNS verification. |
| `swa_id` | Resource ID of the shared Static Web App. | Deploy-workflow/operator-consumed for topology and deployment integration. |

No output may expose provider key-list operations, connection strings, or other
secret material. Secret retrieval remains ephemeral in its consuming stack or
workflow and must never cross the shared-state boundary.
