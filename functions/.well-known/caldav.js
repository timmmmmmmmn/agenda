// Apple en DAVx⁵ zoeken de CalDAV-server via /.well-known/caldav.
export const onRequest = () => new Response(null, { status: 301, headers: { location: '/dav/' } });
