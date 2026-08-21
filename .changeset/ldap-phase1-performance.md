---
'@backstage/plugin-catalog-backend-module-ldap': minor
---

The LDAP org provider now parallelizes user and group reads, requests a minimal default LDAP attribute set instead of `['*', '+']`, hydrates group `member` lists by default (needed for OpenLDAP-style directories without user `memberOf`), only skips group member hydration when user `memberOf` is configured and group `member` is not requested, and reduces memory and CPU overhead during relation resolution, hierarchy building, and entity commit.

If your custom transformers rely on LDAP attributes outside the default set, add an explicit `options.attributes` list (for example `['*', '+']`) to your user and group configuration.
