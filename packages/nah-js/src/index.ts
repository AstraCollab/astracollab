/**
 * `nah-js` — the standalone name for `not-another-harness/js`.
 *
 * The runtime itself lives in the framework package, so there is one
 * implementation and one set of types. This package is the same thing under a
 * shorter import, for applications that would rather depend on `nah-js` than
 * on a subpath of the framework.
 *
 * The server half. The browser half is `nah-js/client`, which is a separate
 * entry point so that React never reaches a server bundle.
 */

export * from "not-another-harness/js";
