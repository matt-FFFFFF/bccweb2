# Run as: terraform show -json plan.binary | jq -f scripts/iac-assertions.jq
# Emits "PASS: <label>" or "FAIL: <reason>" for each of 6 assertions.
# Caller should grep for FAIL to determine overall success.

.planned_values.root_module.resources as $resources |

([$resources[] | select(.address == "azapi_resource.storage")] | .[0]) as $storage |
([$resources[] | select(.address == "azapi_resource.blob_service")] | .[0]) as $blob |
([$resources[] | select(.address == "azapi_resource.storage_lock")] | .[0]) as $lock |

(if $storage == null then {}
 else ($storage.values.body | if type == "string" then fromjson else . end)
 end) as $sa_body |

(if $blob == null then {}
 else ($blob.values.body | if type == "string" then fromjson else . end)
 end) as $bs_body |

($bs_body.properties // {}) as $bs_props |

# 1. Blob versioning enabled
(if $bs_props.isVersioningEnabled == true
 then "PASS: blob versioning enabled"
 else "FAIL: blob versioning not enabled (got \($bs_props.isVersioningEnabled // "missing"))"
 end),

# 2. Blob soft-delete >= 30 days
(($bs_props.deleteRetentionPolicy.days // 0) |
 if . >= 30
 then "PASS: blob soft-delete >= 30 days"
 else "FAIL: blob soft-delete < 30 days (got \(.))"
 end),

# 3. Container soft-delete >= 30 days
(($bs_props.containerDeleteRetentionPolicy.days // 0) |
 if . >= 30
 then "PASS: container soft-delete >= 30 days"
 else "FAIL: container soft-delete < 30 days (got \(.))"
 end),

# 4. Storage replication = GRS
(($sa_body.sku.name // "missing") |
 if . == "Standard_GRS"
 then "PASS: storage replication type is GRS"
 else "FAIL: storage replication type is not GRS (got \(.))"
 end),

# 5. CORS allowedOrigins does not contain "*"
([($bs_props.cors.corsRules // [])[] | (.allowedOrigins // [])[]] |
 if index("*") != null
 then "FAIL: CORS allowedOrigins contains wildcard \"*\""
 else "PASS: CORS allowedOrigins does not contain wildcard"
 end),

# 6. Management lock present
(if $lock != null
 then "PASS: management lock resource present (azapi_resource.storage_lock)"
 else "FAIL: management lock resource not found in plan"
 end)
