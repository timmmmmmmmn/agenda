import { handleDav } from '../_lib/dav.js';

export const onRequest = ({ request, env }) => handleDav(request, env);
