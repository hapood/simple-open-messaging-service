/**
 * Force logout: clear tokens + navigate to the login page.
 * Used on abnormal paths such as refresh reuse (10006) / refresh failure — triggered
 * from the fetch layer, outside the React tree, so it uses window.location instead of
 * useNavigate (a full page reload is acceptable in this scenario).
 *
 * The path MUST carry the configured base prefix. The admin SPA is served under /admin/ in
 * BOTH dev (vite.config.ts `base`) and the docker image (the same value baked into
 * import.meta.env.BASE_URL at build time), so BASE_URL is the single source of truth that keeps
 * the two addresses identical. A bare `/login` lies outside the base: in dev Vite's base
 * middleware rejects it with a 404 "did you mean /admin/login instead?", and in prod it never
 * reaches the admin SPA's Caddy mount at all.
 */
export function forceLogout(): void {
  if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
    window.location.assign(`${import.meta.env.BASE_URL}login`)
  }
}
