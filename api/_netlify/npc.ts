import { handleNpc } from '../npc.ts'

/** Set the site's functions directory to api/_netlify. */
export const config = { path: '/api/npc' }
export default function npc(request: Request, context: { ip: string }) {
  return handleNpc(request, {}, context.ip)
}
