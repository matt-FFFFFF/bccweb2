# Backing up the legacy `BCC_DB` (Azure SQL) via managed-identity BACPAC export

**Status:** operational runbook — on-demand backup of the legacy SQL database

The legacy .NET app's data lives in an **Azure SQL Database** (`BCC_DB` on logical
server `bccweb-prod-9364`) that the blob-based rewrite is migrating away from.
Azure SQL Database has **no `BACKUP DATABASE` T-SQL** — the portable-backup
mechanism is a **BACPAC export** (schema + data as a zip). This doc records the
working, no-secrets way to produce one, and every failure mode we hit getting there.

Two paths exist. **Prefer the server-side export** — it runs in-region, has no local
TLS/connection-concurrency issues, and reuses the `umi-sqlexpo` identity it was built
for. The local SqlPackage path works but chokes on the `S0` tier's connection ceiling
during the data phase (see [Alternative](#alternative-local-sqlpackage-on-net-10)).

## Prod resources

| Thing | Value |
| ----- | ----- |
| Subscription | `ba36d2f0-1de7-4f76-a094-d14fecc61d70` |
| SQL server | `bccweb-prod-9364.database.windows.net` (RG `bccweb-prod-9364`) |
| Database | `BCC_DB` — tier `S0` (10 DTU) |
| Export identity (UMI) | `umi-sqlexpo` (RG `rg-sqlexpo`) — clientId `0daebcef-8dc6-4507-84c9-ee58854b17cd` |
| Backup storage | `dsflgkjdfglnsfkndf` / container `bak` (RG `rg-sqlexpo`) |

Prerequisites: `az` logged in as the server's **Microsoft Entra admin** (needed once,
to create the SQL logins/users), and `sqlcmd` (`brew install sqlcmd`).

## One-time setup (already applied to prod)

A managed-identity export needs the UMI wired at **four** layers — each one only
surfaces the next error once the previous is fixed. All of this is idempotent.

### 1. Attach the UMI to the SQL server as its primary identity

Handles the **storage** auth (and is what the ImportExport service authenticates the
DB connection as).

```sh
UMI="/subscriptions/ba36d2f0-1de7-4f76-a094-d14fecc61d70/resourceGroups/rg-sqlexpo/providers/Microsoft.ManagedIdentity/userAssignedIdentities/umi-sqlexpo"
az sql server update -g bccweb-prod-9364 -n bccweb-prod-9364 \
  --identity-type UserAssigned \
  --user-assigned-identity-id "$UMI" \
  --primary-user-assigned-identity-id "$UMI"
```

The UMI also needs a data role on the storage account (already granted):
`Storage Blob Data Owner` on `dsflgkjdfglnsfkndf`.

### 2–4. Create the login, master user, and DB user + grants

Connect as the Entra admin (`--authentication-method ActiveDirectoryAzCli` reuses your
`az` login). The SID `0x…17CD` is the clientId GUID in SQL binary byte order — using it
avoids a dependency on the server holding the Entra **Directory Readers** role.

```sh
S=bccweb-prod-9364.database.windows.net

# master: server-level login + a user so the login can open its default DB
sqlcmd -S $S -d master --authentication-method ActiveDirectoryAzCli -Q "CREATE LOGIN [umi-sqlexpo] FROM EXTERNAL PROVIDER;"
sqlcmd -S $S -d master --authentication-method ActiveDirectoryAzCli -Q "CREATE USER [umi-sqlexpo] FROM LOGIN [umi-sqlexpo];"

# BCC_DB: user + read data + read schema (both required for a BACPAC)
sqlcmd -S $S -d BCC_DB --authentication-method ActiveDirectoryAzCli -Q "CREATE USER [umi-sqlexpo] WITH SID = 0xEFBCAE0DC68D074584C9EE58854B17CD, TYPE = E;"
sqlcmd -S $S -d BCC_DB --authentication-method ActiveDirectoryAzCli -Q "ALTER ROLE db_datareader ADD MEMBER [umi-sqlexpo]; GRANT VIEW DEFINITION TO [umi-sqlexpo];"
```

> `FROM EXTERNAL PROVIDER` for the `master` login requires the server to resolve the
> identity in Entra (it can). `WITH SID … TYPE=E` is used for the `BCC_DB` user because
> Azure SQL DB rejects `WITH SID` on `CREATE LOGIN`. All SIDs must match (`0x…17CD`).

## Take a backup

### 1. Server-side export → blob

```sh
UMI="/subscriptions/ba36d2f0-1de7-4f76-a094-d14fecc61d70/resourceGroups/rg-sqlexpo/providers/Microsoft.ManagedIdentity/userAssignedIdentities/umi-sqlexpo"
BACPAC="BCC_DB-$(date +%Y%m%d-%H%M).bacpac"

az sql db export -g bccweb-prod-9364 -s bccweb-prod-9364 -n BCC_DB \
  --auth-type ManagedIdentity  --admin-user "$UMI" \
  --storage-key-type ManagedIdentity --storage-key "$UMI" \
  --storage-uri "https://dsflgkjdfglnsfkndf.blob.core.windows.net/bak/$BACPAC" \
  --no-wait
```

- `--auth-type ManagedIdentity` drives the **database** connection; `--admin-user` must
  be the UMI **resource ID** (not the name).
- `--storage-key-type ManagedIdentity` + `--storage-key <UMI resource ID>` drives the
  **storage** write.
- No passwords anywhere — that's the point of the UMI.

### 2. Poll to completion

`percentComplete` is cosmetic (sits at 0–1% then jumps to 100). Wait for `Succeeded`:

```sh
az sql db op list -g bccweb-prod-9364 -s bccweb-prod-9364 -d BCC_DB \
  --query "reverse(sort_by([?operation=='ExportDatabase'],&startTime))[0].{state:state,err:errorDescription}" -o json
```

If it ever fails, the `errorDescription` field carries the real reason — it's precise
(see [Troubleshooting](#troubleshooting)). On `S0` the export is DTU-throttled and can
take many minutes; that's expected, not stalled.

### 3. Download the BACPAC locally

`az` control-plane users can't read blobs by default; download with the account key
(shared-key access is enabled on the account):

```sh
KEY=$(az storage account keys list -g rg-sqlexpo -n dsflgkjdfglnsfkndf --query "[0].value" -o tsv)
az storage blob download --account-name dsflgkjdfglnsfkndf --account-key "$KEY" \
  -c bak -n "$BACPAC" -f "$HOME/Downloads/$BACPAC"
```

Verify it's a well-formed BACPAC (a zip holding `model.xml`, `Origin.xml`, `Data/`):

```sh
unzip -l "$HOME/Downloads/$BACPAC" | grep -E "model.xml|Origin.xml|Data/"
```

> **PII:** `BCC_DB` holds pilot personal data. A downloaded BACPAC is unencrypted PII on
> local disk — store it securely and delete it when done. Do not commit it.

## Troubleshooting

Every layer surfaces a distinct error; fix in order.

| Error (from `errorDescription` or SqlPackage) | Cause | Fix |
| --- | --- | --- |
| `storageKey invalid … Managed Identity resource ID should be associated with the server` | UMI not attached to the server | Setup step 1 (`az sql server update … --primary-user-assigned-identity-id`) |
| `Login failed for user '<token-identified principal>'` | No server-level login | `CREATE LOGIN … FROM EXTERNAL PROVIDER` in `master` |
| `Cannot open user default database. Login failed.` | Login has no user in `master` | `CREATE USER … FROM LOGIN` in `master` |
| `sqlLogin is invalid … Managed Identity resource ID should be associated with the server` | `--admin-user` was the identity **name** | pass the UMI **resource ID** |
| `you do not have View Definition permission on 'BCC_DB' … Could not extract package` | UMI can read data but not schema | `GRANT VIEW DEFINITION TO [umi-sqlexpo]` |

## Alternative: local SqlPackage on .NET 10

SqlPackage can export straight to disk (no blob round-trip), authenticating with your
own Entra token (`az account get-access-token --resource https://database.windows.net`).
It **works on .NET 10** but has caveats:

- **Runtime:** SqlPackage 170.x pins `Microsoft.NETCore.App` 8.0.27. On a machine with
  only newer/older runtimes, install with roll-forward
  (`dotnet tool install -g microsoft.sqlpackage --allow-roll-forward`) and point
  `DOTNET_ROOT` at a .NET ≥ 8.0.27 install (Homebrew's .NET 10 works via roll-forward;
  a mise `dotnet@8.0.422` = runtime 8.0.28 also works). The apphost needs `DOTNET_ROOT`
  or `/etc/dotnet/install_location` — Homebrew registers neither.
- **`S0` limit (the blocker):** schema extraction (one connection) succeeds, but the
  parallel **data** phase saturates `S0`'s DTU/connection budget and fails with
  `post-login timeout` → `SSL handshake failed` on the concurrent connections. To use
  this path, temporarily scale up, export, then scale back:
  `az sql db update … --service-objective S3` → export → `--service-objective S0`.

Because of the `S0` data-phase issue, the **server-side export above is preferred**.

## Teardown / recurring backups

To reverse the grants (e.g. decommissioning the export identity):

```sql
-- BCC_DB
DROP USER [umi-sqlexpo];
-- master
DROP USER [umi-sqlexpo];
DROP LOGIN [umi-sqlexpo];
```

…and remove the server identity assignment / storage role assignment.

If backups become **recurring**, codify this instead of leaving it as manual steps:
the identity assignment + storage role in Terraform (`iac/service`), and the SQL
logins/users/grants as an idempotent script — so they survive a server rebuild.
