// "/" is de webinterface, maar sommige CalDAV-clients doen eerst een PROPFIND op "/".
import { handleDav } from './_lib/dav.js';

export const onRequest = ({ request, env, next }) => {
  const m = request.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'POST') return next();
  return handleDav(request, env);
};
