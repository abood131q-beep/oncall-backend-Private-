'use strict';

/** Documents port boundary. The legacy API exposes no driver-document endpoint
 * or table, so this adapter intentionally has no mounted operation. It prevents
 * inventing a feature while reserving the ADR-004 ownership boundary. */
function createDriverDocumentsAdapter() {
  return Object.freeze({});
}
module.exports = { createDriverDocumentsAdapter };
