export function isSameOriginPath(url, port, pathname) {
  return (
    url.origin === `http://127.0.0.1:${port}`
    && url.pathname === pathname
  );
}
