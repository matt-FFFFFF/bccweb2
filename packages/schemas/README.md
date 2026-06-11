# @bccweb/schemas

Shared Zod schemas for validating and healing JSON blob shapes before they are
used by the API.

## Healing policy (uniform)

- identity hard-fail
- enum preprocess
- scalar defaults
- optional lenient
- unknown strip

## WingClass break-glass

Adding a `WingClass` requires this order: types → schema → API deploy → admin UI
emits new key. Reverse order causes enforce-mode rejection.
