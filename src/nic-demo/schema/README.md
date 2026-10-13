# Vendored schemas

`nic-content-request-1.schema.json` and `nic-content-1.schema.json` are **copies**.
The canonical versions live in the mcphub repo, next to the consumer that reads the output:

`packages/plugins/nic-wp-plugin/framework/nic-core/schema/`

Spec: `docs/superpowers/specs/2026-10-13-demo-content-contract.md` (same repo).

Do not edit these files here. Change the canonical copy, then re-copy it byte for byte.
The `nic-demo` exporter validates its input and its output against them, so a drifted
copy makes ThemeSeed accept or write something NIC Core rejects.
