import { handle } from '../../cloudflare/api.mjs';
export const onRequest = context => handle(context.request, context.env);
