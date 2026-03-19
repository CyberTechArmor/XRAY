import { getEmbedDashboard as getEmbed } from './dashboard.service';

export async function getEmbedDashboard(embedToken: string): Promise<Record<string, unknown>> {
  return getEmbed(embedToken) as unknown as Promise<Record<string, unknown>>;
}
