'use strict';

/**
 * SDK ↔ Multi-Tenancy adapter (Phase 15.9 / ADR-038 §7/§9). Gives an Extension a
 * granted, namespace-isolated Tenancy port WITHOUT leaking engine internals or
 * allowing cross-tenant access. Security:
 *   • Namespace isolation — every call is forced into the extension's own
 *     namespace (`ext.<owner>`).
 *   • Cross-tenant access prevention — when the adapter is bound to a `tenantId`,
 *     resolveTenant may only resolve THAT tenant; a request for any other tenant
 *     throws CrossTenantError.
 *   • Permission — resolveTenant/verify/list require `tenant:read`; register/activate/
 *     deactivate require `tenant:manage`. Missing capability → PermissionError.
 */

const { PermissionError } = require('../../sdk/extensions/errors');
const { CrossTenantError } = require('../../domain/tenancy/errors');

function toTenancyPort(
  tenancy,
  { owner, tenantId = null, canRead = true, canManage = false, namespacePrefix = 'ext.' } = {}
) {
  if (!owner) throw new Error('toTenancyPort: owner required');
  const namespace = `${namespacePrefix}${owner}`;

  const requireRead = () => {
    if (!canRead) throw new PermissionError(`extension "${owner}" lacks capability "tenant:read"`);
  };
  const requireManage = () => {
    if (!canManage) {
      throw new PermissionError(`extension "${owner}" lacks capability "tenant:manage"`);
    }
  };
  // Cross-tenant guard: a tenant-scoped adapter cannot touch a different tenant.
  const guardTenant = (spec) => {
    if (tenantId && spec && spec.tenantId && spec.tenantId !== tenantId) {
      throw new CrossTenantError(
        `extension "${owner}" (tenant "${tenantId}") may not access tenant "${spec.tenantId}"`
      );
    }
  };

  return {
    registerTenant(spec = {}) {
      requireManage();
      return tenancy.registerTenant(spec, { namespace });
    },
    resolveTenant(spec = {}) {
      requireRead();
      guardTenant(spec);
      const scoped = tenantId && !spec.tenantId && !spec.tenantName ? { ...spec, tenantId } : spec;
      return tenancy.resolveTenant(scoped, { namespace });
    },
    activateTenant(spec = {}) {
      requireManage();
      guardTenant(spec);
      return tenancy.activateTenant(spec, { namespace });
    },
    deactivateTenant(spec = {}) {
      requireManage();
      guardTenant(spec);
      return tenancy.deactivateTenant(spec, { namespace });
    },
    verify() {
      requireRead();
      return tenancy.verify({ namespace });
    },
    list() {
      requireRead();
      return tenancy.list({ namespace });
    },
    health() {
      return tenancy.health();
    },
  };
}

module.exports = { toTenancyPort };
